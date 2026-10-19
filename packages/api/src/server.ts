import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { gzipSync, deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  MAX_QUERY_LIMIT,
  DEFAULT_MAX_QUERY_LIMIT,
  LATEST_SCHEMA_VERSION,
  ContractTypedDecoder,
  SpecCache,
  type EventStore,
  type Logger,
} from '@soroban-lens/store';
import { ApiError } from './errors.js';
import { assertContractId, parseEventQuery, parseIds } from './params.js';
import { executeGraphQL, type GraphQLOptions } from './graphql.js';
import { WebhookManager, type WebhookOptions } from './webhooks.js';

export interface ApiServerOptions {
  store: EventStore;
  /** Allowed CORS origin. Defaults to "*" — the API is read-only and unauthenticated. */
  corsOrigin?: string;
  /** Build/version string reported by /health. */
  version?: string;
  /**
   * Network this database was indexed from, reported by /health.
   * A store holds events from exactly one network, so a UI can use this to
   * confirm it is pointed where the user thinks it is.
   */
  network?: string;
  /** Structured logger, shared with the store's own logging (#16). Defaults to silent. */
  log?: Logger;
  /** Optional GraphQL endpoint at /graphql. Disabled unless `enabled: true` (#60). */
  graphql?: GraphQLOptions;
  /** Optional webhook subscriptions at /webhooks. Disabled unless `enabled: true` (#59). */
  webhooks?: WebhookOptions;
}

/** Largest request body accepted by the POST routes. */
const MAX_BODY_BYTES = 100 * 1024;

/** Read and parse a JSON request body, refusing anything over `MAX_BODY_BYTES`. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ApiError(413, 'payload_too_large', `The request body must be at most ${MAX_BODY_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw ApiError.badRequest('A JSON request body is required.');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw ApiError.badRequest('The request body is not valid JSON.');
  }
}

type Handler = (ctx: {
  params: string[];
  query: URLSearchParams;
  store: EventStore;
  options: ApiServerOptions;
  /** Parsed contract specs, for the typed view of each event (#33). */
  specs: SpecCache;
  /** Present only when webhooks are enabled. */
  webhooks: WebhookManager | undefined;
  headers: IncomingMessage['headers'];
  /** Parse the request body as JSON, bounded to `MAX_BODY_BYTES`. */
  readJson: () => Promise<unknown>;
}) => Promise<{ status?: number; body: unknown; contentType?: string }>;

/** Matches "/contracts/{id}/events" and friends. */
interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
  /** Serves without reading event rows, so a pending migration does not block it. */
  exemptFromSchemaCheck?: boolean;
}

/**
 * How long a client should wait before retrying during a migration.
 *
 * A migration on a SQLite file is seconds, not minutes. Short enough that a
 * poller recovers promptly; long enough that it does not hammer the API while
 * the migration holds the write lock.
 */
const MIGRATION_RETRY_AFTER_SECONDS = 5;

/**
 * Data routes refuse to serve from a half-migrated database.
 *
 * /health and /openapi.json are deliberately exempt: health is how an operator
 * finds out *why* everything else is 503ing, and a spec is static. Returning
 * rows from a schema the code does not expect is worse than being briefly
 * unavailable — the rows would look plausible and be wrong.
 */
async function assertSchemaCurrent(store: EventStore): Promise<void> {
  const { schemaVersion } = await store.getStats();
  if (schemaVersion === LATEST_SCHEMA_VERSION) return;
  throw ApiError.unavailable(
    `The database is at schema v${schemaVersion}, expected v${LATEST_SCHEMA_VERSION}. ` +
      'A migration is pending; see GET /health.',
    MIGRATION_RETRY_AFTER_SECONDS,
  );
}

const routes: Route[] = [
  {
    // Liveness plus a real write probe against the store, so a read-only volume
    // shows up here rather than as a mysterious indexer failure later.
    method: 'GET',
    pattern: /^\/health$/,
    exemptFromSchemaCheck: true,
    handler: async ({ store, options }) => {
      const health = await store.healthCheck();
      const stats = await store.getStats();
      return {
        status: health.ok ? 200 : 503,
        body: {
          status: health.ok ? 'ok' : 'degraded',
          detail: health.detail,
          version: options.version ?? '0.1.0',
          network: options.network ?? 'unknown',
          uptimeSeconds: Math.round(process.uptime()),
          events: stats.eventCount,
          contracts: stats.contractCount,
          schemaVersion: stats.schemaVersion,
        },
      };
    },
  },
  {
    method: 'GET',
    pattern: /^\/stats$/,
    handler: async ({ store }) => {
      // topTopics answers "what event types are in here at all" without
      // paging the whole table (#30).
      const [stats, topTopics] = await Promise.all([store.getStats(), store.countByTopic(10)]);
      return { body: { ...stats, topTopics } };
    },
  },
  {
    // Indexer progress, so the UI can show lag without talking to the RPC.
    method: 'GET',
    pattern: /^\/status$/,
    handler: async ({ store }) => {
      const [stats, streams] = await Promise.all([store.getStats(), store.listStreamStates()]);
      return { body: { ...stats, streams } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts$/,
    handler: async ({ store, query }) => {
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      return { body: { contracts: await store.listContracts(limit) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/events$/,
    handler: async ({ params, query, store, specs }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const page = await store.queryEvents({ ...parseEventQuery(query), contractId });
      const events = await specs.annotate(page.events);
      if (page.events.length > 0) return { body: { ...page, events } };

      // An empty page is three different situations (#58). Telling them apart
      // takes one more query, so it is only paid on the empty path: is there
      // *any* event for this contract, ignoring the filters?
      const known = await store.queryEvents({ contractId, limit: 1 });
      if (known.events.length === 0) {
        throw ApiError.notFound(
          `No indexed events for contract "${contractId}". ` +
            'The contract may not exist, or may exist on-chain but not be one this instance indexes — ' +
            'check LENS_CONTRACT_IDS.',
        );
      }
      return { body: { ...page, events, emptyReason: 'no_matching_events' } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/stats$/,
    handler: async ({ params, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      // listContracts already computes exactly this summary per contract; the
      // route exists so a caller does not have to fetch them all and filter.
      const summary = (await store.listContracts(MAX_QUERY_LIMIT)).find(
        (c) => c.contractId === contractId,
      );
      if (!summary) {
        throw ApiError.notFound(
          `No indexed events for contract "${contractId}". ` +
            'The contract may exist on-chain but not be one this instance indexes — ' +
            'check LENS_CONTRACT_IDS.',
        );
      }
      return { body: summary };
    },
  },
  {
    // What typed decoding knows about a contract (#33): where its spec came
    // from and which events it declares. 404 when it was never looked up,
    // which is different from a lookup that found nothing (source "none").
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/spec$/,
    handler: async ({ params, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const record = await store.getContractSpec(contractId);
      if (!record) {
        throw ApiError.notFound(
          `No spec has been looked up for contract "${contractId}". ` +
            'The indexer fetches specs for contracts it indexes; `lens spec fetch -c <id>` does it on demand.',
        );
      }
      let events: string[] = [];
      try {
        events = ContractTypedDecoder.fromRecord(record)?.eventNames() ?? [];
      } catch {
        // Unparseable stored entries: report the record, with no events.
      }
      const { entriesXdr: _entries, ...summary } = record;
      return { body: { ...summary, events } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/contracts\/([^/]+)\/topics$/,
    handler: async ({ params, query, store }) => {
      const contractId = assertContractId(decodeURIComponent(params[0] as string));
      const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
      return { body: { contractId, topics: await store.listTopics(contractId, limit) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/events$/,
    handler: async ({ query, store, specs }) => {
      // ?ids= is a batch lookup, not a filter: it resolves a known list in one
      // round trip rather than N. It short-circuits the filter path entirely,
      // since mixing "these exact events" with "events matching X" has no
      // sensible meaning.
      const ids = parseIds(query);
      if (ids) {
        const found = await Promise.all(ids.map((id) => store.getEvent(id)));
        return {
          body: {
            events: await specs.annotate(found.filter((e): e is NonNullable<typeof e> => e !== null)),
            // Reported rather than silently dropped, so a caller can tell
            // "not indexed" from "I typo'd the id".
            missing: ids.filter((_, i) => found[i] === null),
          },
        };
      }
      const page = await store.queryEvents(parseEventQuery(query));
      return { body: { ...page, events: await specs.annotate(page.events) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/events\/([^/]+)$/,
    handler: async ({ params, store, specs }) => {
      const id = decodeURIComponent(params[0] as string);
      const event = await store.getEvent(id);
      if (!event) throw ApiError.notFound(`No indexed event with id "${id}".`);
      const [annotated] = await specs.annotate([event]);
      return { body: annotated };
    },
  },
  {
    // Optional GraphQL over the same store (#60). GET carries the query in the
    // URL, POST in a JSON body, per the GraphQL-over-HTTP convention.
    method: 'GET',
    pattern: /^\/graphql$/,
    handler: async ({ query, store, options }) => {
      requireGraphQL(options);
      const variables = query.get('variables');
      let parsed: unknown;
      if (variables) {
        try {
          parsed = JSON.parse(variables);
        } catch {
          throw ApiError.badRequest('"variables" must be a JSON object.', 'variables');
        }
      }
      const result = await executeGraphQL(
        { query: query.get('query') ?? '', variables: parsed, operationName: query.get('operationName') ?? undefined },
        store,
        options.graphql,
      );
      return { status: result.status, body: result.body };
    },
  },
  {
    method: 'POST',
    pattern: /^\/graphql$/,
    handler: async ({ store, options, readJson }) => {
      requireGraphQL(options);
      const body = await readJson();
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw ApiError.badRequest('The request body must be a JSON object with a "query" string.');
      }
      const { query, variables, operationName } = body as Record<string, unknown>;
      const result = await executeGraphQL(
        {
          query: typeof query === 'string' ? query : '',
          variables,
          operationName: typeof operationName === 'string' ? operationName : undefined,
        },
        store,
        options.graphql,
      );
      return { status: result.status, body: result.body };
    },
  },
  {
    method: 'POST',
    pattern: /^\/webhooks$/,
    handler: async ({ webhooks, headers, readJson }) => {
      const manager = requireWebhooks(webhooks, headers);
      return { status: 201, body: await manager.register(await readJson()) };
    },
  },
  {
    method: 'GET',
    pattern: /^\/webhooks$/,
    handler: async ({ webhooks, headers }) => {
      return { body: { webhooks: requireWebhooks(webhooks, headers).list() } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/webhooks\/([^/]+)$/,
    handler: async ({ params, webhooks, headers }) => {
      return { body: requireWebhooks(webhooks, headers).get(decodeURIComponent(params[0] as string)) };
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/webhooks\/([^/]+)$/,
    handler: async ({ params, webhooks, headers }) => {
      const id = decodeURIComponent(params[0] as string);
      requireWebhooks(webhooks, headers).remove(id);
      return { body: { deleted: true, id } };
    },
  },
  {
    // Events that exhausted their retries. The record is how a receiver that
    // was down for longer than the retry window finds out what it missed.
    method: 'GET',
    pattern: /^\/webhooks\/([^/]+)\/dead-letters$/,
    handler: async ({ params, webhooks, headers }) => {
      const id = decodeURIComponent(params[0] as string);
      return { body: { deadLetters: requireWebhooks(webhooks, headers).deadLetters(id) } };
    },
  },
  {
    method: 'GET',
    pattern: /^\/openapi\.json$/,
    exemptFromSchemaCheck: true,
    handler: async () => ({
      body: await servedSpec(),
      contentType: 'application/json; charset=utf-8',
    }),
  },
  {
    // A browsable page over the same spec /openapi.json serves, for a
    // newcomer who would rather click through routes than read raw JSON.
    // Redoc reads /openapi.json client-side, same-origin, so this route
    // itself never needs to know the spec's content and stays exempt from
    // the schema-currency check the same way the JSON route already is.
    method: 'GET',
    pattern: /^\/docs$/,
    exemptFromSchemaCheck: true,
    handler: async () => ({
      body: DOCS_HTML,
      contentType: 'text/html; charset=utf-8',
    }),
  },
];

/** 404 rather than 403 while disabled: the endpoint simply does not exist. */
function requireGraphQL(options: ApiServerOptions): void {
  if (!options.graphql?.enabled) {
    throw ApiError.notFound('GraphQL is disabled. Start the API with LENS_GRAPHQL=1 to enable /graphql.');
  }
}

function requireWebhooks(
  webhooks: WebhookManager | undefined,
  headers: IncomingMessage['headers'],
): WebhookManager {
  if (!webhooks) {
    throw ApiError.notFound('Webhook subscriptions are disabled. Start the API with LENS_WEBHOOKS=1 to enable /webhooks.');
  }
  const auth = headers['authorization'];
  webhooks.authorize(Array.isArray(auth) ? auth[0] : auth);
  return webhooks;
}

/**
 * Redoc, pinned to an exact version from a CDN — not `@latest`, so an
 * unrelated Redoc release can never change what this route serves. Reads
 * /openapi.json itself, so this page carries no spec content of its own and
 * cannot drift from the committed spec the way a static copy could.
 */
const DOCS_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>soroban-lens API</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>body { margin: 0; padding: 0; }</style>
</head>
<body>
  <redoc spec-url="/openapi.json"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.5.4/bundles/redoc.standalone.js"></script>
</body>
</html>
`;

/**
 * The committed spec with the live query ceiling patched in.
 *
 * MAX_QUERY_LIMIT is configurable (#55), so a spec that always claimed 1000
 * would be wrong on any instance that changed it — and the spec is what a
 * generated client trusts. The file on disk stays the documented default; only
 * what is served reflects the running configuration.
 */
async function servedSpec(): Promise<string> {
  const raw = await readFile(join(packageRoot(), 'openapi.json'), 'utf8');
  if (MAX_QUERY_LIMIT === DEFAULT_MAX_QUERY_LIMIT) return raw;

  const spec = JSON.parse(raw) as {
    components?: { parameters?: Record<string, { schema?: { maximum?: number } }> };
  };
  const limit = spec.components?.parameters?.['Limit'];
  if (limit?.schema) limit.schema.maximum = MAX_QUERY_LIMIT;
  return JSON.stringify(spec, null, 2);
}

function packageRoot(): string {
  // dist/server.js -> package root
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Build the HTTP server.
 *
 * Plain `node:http` with a regex table rather than a framework: the whole
 * surface is eight read-only GET routes, and a dependency-light stack is a
 * stated goal of the project. If this ever grows auth, rate limiting or
 * content negotiation, that is the moment to reach for a framework.
 */
export function createApiServer(options: ApiServerOptions): Server {
  const { store } = options;
  const log = options.log ?? { debug() {}, info() {}, warn() {}, error() {} };
  const corsOrigin = options.corsOrigin ?? '*';
  // One per server: specs are per database, and the TTL is what lets a spec
  // the indexer fetches after startup show up without restarting the API.
  const specs = new SpecCache((contractId) => store.getContractSpec(contractId));
  const webhooks = options.webhooks?.enabled ? new WebhookManager(store, options.webhooks, log) : undefined;

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
  if (webhooks) {
    webhooks.start();
    // The dispatcher's timer is unref'd, but stopping it explicitly also ends
    // any delivery that is sleeping between retries.
    server.on('close', () => webhooks.stop());
  }
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    // The base is a placeholder; only pathname and search are ever read.
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Honour an id a trusted upstream (a gateway, a load balancer) already
    // assigned, so the same request keeps one id end to end rather than a
    // new one appearing at each hop; generate one otherwise. v0.1 already
    // assumes a trusted network for exactly this kind of header.
    const inbound = req.headers['x-request-id'];
    const requestId =
      (Array.isArray(inbound) ? inbound[0] : inbound)?.trim().slice(0, 200) || randomUUID();
    res.setHeader('X-Request-Id', requestId);

    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // HEAD is GET without the body. RFC 9110 requires the headers to be the
    // ones GET would have sent, so it runs the real handler and drops the
    // payload at the end rather than short-circuiting to an empty 200 —
    // Content-Length, Content-Type and the status all stay truthful, including
    // on a 404. Monitoring tools use HEAD routinely and used to get a 405.
    const isHead = req.method === 'HEAD';
    const method = isHead ? 'GET' : req.method;

    try {
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const candidates = routes.filter((r) => r.pattern.test(path));

      if (candidates.length === 0) {
        throw ApiError.notFound(`No route for ${req.method} ${path}. See GET /openapi.json.`);
      }
      const route = candidates.find((r) => r.method === method);
      if (!route) {
        const allowed = [...new Set(candidates.map((r) => r.method))];
        throw new ApiError(
          405,
          'method_not_allowed',
          `${path} accepts ${allowed.join(', ')} only.`,
          undefined,
          // HEAD rides along with GET (RFC 9110), so Allow must say so.
          allowed.flatMap((m) => (m === 'GET' ? ['GET', 'HEAD'] : [m])).join(', '),
        );
      }

      // Everything except /health and /openapi.json reads rows, so everything
      // else waits for the schema to be current.
      if (!route.exemptFromSchemaCheck) await assertSchemaCurrent(store);

      const match = route.pattern.exec(path);
      const result = await route.handler({
        params: match ? match.slice(1) : [],
        query: url.searchParams,
        store,
        options,
        specs,
        webhooks,
        headers: req.headers,
        readJson: () => readJsonBody(req),
      });

      send(res, result.status ?? 200, result.body, result.contentType, isHead, req.headers['accept-encoding']);
      const status = result.status ?? 200;
      const durationMs = Date.now() - started;
      log.info(
        'request_handled',
        `${req.method} ${url.pathname}${url.search} -> ${status} (${durationMs}ms)`,
        { method: req.method, path: url.pathname, status, durationMs, requestId },
      );
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError(500, 'internal_error', error instanceof Error ? error.message : String(error));
      if (apiError.allow) res.setHeader('Allow', apiError.allow);
      if (apiError.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(apiError.retryAfterSeconds));
      }
      if (apiError.status >= 500) {
        log.error(
          'request_failed',
          `${req.method} ${url.pathname} -> ${apiError.status}: ${error instanceof Error ? error.stack : error}`,
          { method: req.method, path: url.pathname, status: apiError.status, requestId },
        );
      }
      send(res, apiError.status, apiError.toBody(requestId), undefined, isHead, req.headers['accept-encoding']);
    }
  }
}

// Below this, gzip/deflate's own framing overhead can cost more than it
// saves — matches the same "measure before compressing unconditionally"
// finding #35 made for the raw-XDR columns, applied here rather than assumed.
const COMPRESSION_THRESHOLD_BYTES = 1024;

function pickEncoding(acceptEncoding: string | string[] | undefined): 'gzip' | 'deflate' | undefined {
  const header = Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : (acceptEncoding ?? '');
  // Order of preference, not the client's — gzip is at least as well
  // supported as deflate and typically compresses slightly better, so it
  // wins when a client (correctly) advertises both with no explicit q-values.
  if (/(?:^|,)\s*gzip\s*(?:;|,|$)/i.test(header)) return 'gzip';
  if (/(?:^|,)\s*deflate\s*(?:;|,|$)/i.test(header)) return 'deflate';
  return undefined;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType?: string,
  headOnly = false,
  acceptEncoding?: string | string[],
): void {
  // A handler that already produced a JSON string (the OpenAPI document) passes
  // it through untouched rather than being re-serialised.
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  const rawBytes = Buffer.byteLength(payload);

  const encoding = rawBytes >= COMPRESSION_THRESHOLD_BYTES ? pickEncoding(acceptEncoding) : undefined;
  const compressed = encoding === 'gzip' ? gzipSync(payload) : encoding === 'deflate' ? deflateSync(payload) : undefined;

  res.writeHead(status, {
    'Content-Type': contentType ?? 'application/json; charset=utf-8',
    // Deliberately the length the body *would* have had. RFC 9110 says a HEAD
    // response carries the same Content-Length as the GET, and a client that
    // sizes a request from it would otherwise read zero.
    'Content-Length': compressed ? compressed.length : rawBytes,
    ...(encoding ? { 'Content-Encoding': encoding } : {}),
    // A cache or proxy in front of this must know the body varies by this
    // header, or it can serve a gzipped response to a client that never asked
    // for one (or vice versa).
    Vary: 'Accept-Encoding',
    'Cache-Control': 'no-store',
  });
  res.end(headOnly ? undefined : (compressed ?? payload));
}
