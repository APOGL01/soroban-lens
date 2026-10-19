import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventQuery, EventStore, LensEvent, Logger } from '@soroban-lens/store';
import { ApiError } from './errors.js';

export interface EventStreamOptions {
  /** How often to look for newly indexed events. @default 1000 */
  pollIntervalMs?: number;
  /** How often to send an SSE comment so proxies keep an idle connection open. @default 15000 */
  heartbeatMs?: number;
  /** Open streams beyond this are refused with 503. @default 1000 */
  maxStreams?: number;
  /** Events written per query while catching a stream up. @default 100 */
  batchSize?: number;
}

interface Subscriber {
  res: ServerResponse;
  query: EventQuery;
  /** The last event id this stream has passed, or ''. Everything after it is still owed. */
  lastId: string;
  draining: boolean;
}

/**
 * Fans newly indexed events out to Server-Sent-Event streams.
 *
 * The indexer is a separate process writing to the same database, so there is
 * nothing to subscribe to; instead one shared timer asks the store for its
 * newest id and only queries on behalf of streams that are behind it. Per
 * stream the state is a single id: nothing is buffered, and a client that
 * cannot keep up is skipped until its socket drains, so memory stays flat no
 * matter how many streams are open or how slow they are.
 */
export class EventStreamHub {
  readonly #store: EventStore;
  readonly #annotate: (events: LensEvent[]) => Promise<LensEvent[]>;
  readonly #log: Logger;
  readonly #pollIntervalMs: number;
  readonly #heartbeatMs: number;
  readonly #maxStreams: number;
  readonly #batchSize: number;
  readonly #subscribers = new Set<Subscriber>();
  #pollTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #polling = false;

  constructor(
    store: EventStore,
    annotate: (events: LensEvent[]) => Promise<LensEvent[]>,
    log: Logger,
    options: EventStreamOptions = {},
  ) {
    this.#store = store;
    this.#annotate = annotate;
    this.#log = log;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#heartbeatMs = options.heartbeatMs ?? 15_000;
    this.#maxStreams = options.maxStreams ?? 1000;
    this.#batchSize = options.batchSize ?? 100;
  }

  get size(): number {
    return this.#subscribers.size;
  }

  /**
   * Open a stream. `after` is the `Last-Event-ID` to resume from; without one the
   * stream starts at the present and carries only events indexed from now on.
   */
  async subscribe(
    req: IncomingMessage,
    res: ServerResponse,
    query: EventQuery,
    after: string | undefined,
  ): Promise<void> {
    if (this.#subscribers.size >= this.#maxStreams) {
      throw ApiError.unavailable(`At most ${this.#maxStreams} event streams may be open at once.`, 5);
    }

    const lastId = after ?? (await this.#store.getLatestEventId()) ?? '';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer, which would hold events back.
      'X-Accel-Buffering': 'no',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    // `retry` is how long a browser's EventSource waits before reconnecting.
    res.write('retry: 3000\n\n');

    const subscriber: Subscriber = { res, query, lastId, draining: false };
    this.#subscribers.add(subscriber);
    this.#start();
    res.on('close', () => {
      this.#subscribers.delete(subscriber);
      if (this.#subscribers.size === 0) this.#stop();
    });

    // A resuming client is owed events right away, not one poll interval from now.
    const latest = await this.#store.getLatestEventId();
    if (latest !== null) void this.#drain(subscriber, latest);
  }

  /** End every open stream. Called on shutdown, as an open stream would otherwise hold `server.close()` forever. */
  closeAll(): void {
    for (const { res } of this.#subscribers) res.end();
    this.#subscribers.clear();
    this.#stop();
  }

  #start(): void {
    if (this.#pollTimer) return;
    this.#pollTimer = setInterval(() => void this.#poll(), this.#pollIntervalMs);
    this.#heartbeatTimer = setInterval(() => {
      for (const { res } of this.#subscribers) if (!res.writableNeedDrain) res.write(': keep-alive\n\n');
    }, this.#heartbeatMs);
    this.#pollTimer.unref();
    this.#heartbeatTimer.unref();
  }

  #stop(): void {
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#pollTimer = undefined;
    this.#heartbeatTimer = undefined;
  }

  async #poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const latest = await this.#store.getLatestEventId();
      if (latest === null) return;
      for (const subscriber of [...this.#subscribers]) {
        if (latest > subscriber.lastId) await this.#drain(subscriber, latest);
      }
    } catch (error) {
      this.#log.warn('stream_poll_failed', `event stream poll failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.#polling = false;
    }
  }

  /**
   * Write every event after the subscriber's position that matches its filter.
   *
   * `latest` was read before the query ran, so once a query comes back with
   * nothing more, everything up to `latest` has been checked and the position
   * can jump there. That is what stops a stream whose filter matches nothing
   * from re-querying the same range on every poll.
   */
  async #drain(subscriber: Subscriber, latest: string): Promise<void> {
    if (subscriber.draining) return;
    subscriber.draining = true;
    try {
      for (;;) {
        const { res } = subscriber;
        if (res.destroyed || res.writableEnded || res.writableNeedDrain) return;

        const page = await this.#store.queryEvents({
          ...subscriber.query,
          order: 'asc',
          direction: 'forward',
          limit: this.#batchSize,
          skipTotal: true,
          ...(subscriber.lastId ? { cursor: subscriber.lastId } : {}),
        });

        const annotated = await this.#annotate(page.events);
        for (const [i, event] of annotated.entries()) {
          res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          subscriber.lastId = page.events[i]?.id ?? event.id;
        }

        if (!page.nextCursor) {
          if (latest > subscriber.lastId) subscriber.lastId = latest;
          return;
        }
      }
    } catch (error) {
      this.#log.warn('stream_drain_failed', `event stream drain failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      subscriber.draining = false;
    }
  }
}
