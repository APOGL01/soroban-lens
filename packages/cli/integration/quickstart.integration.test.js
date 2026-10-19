/**
 * Integration suite against a real node (#20).
 *
 * Every other ingest test uses a scripted fake client, which is right for
 * retention-gap and reorg simulation but means nothing else has exercised a real
 * JSON-RPC round trip, real XDR off the wire, or a real cursor. This does: it
 * funds two accounts, deploys the native Stellar Asset Contract on a local
 * `stellar/quickstart` network, transfers between the accounts, then runs the
 * actual indexer and asserts the contract's `transfer` event is stored.
 *
 * A Stellar Asset Contract is a real, deployed contract that emits real events
 * but needs no Rust toolchain or wasm build, so CI stays a Docker container and
 * Node. It is also the contract the project's own quickstart watches.
 *
 * Opt-in and kept out of `npm test`, so the default suite stays offline:
 *
 *   docker compose -f docker-compose.integration.yml up -d
 *   npm run test:integration
 *
 * LENS_IT_RPC_URL (default http://localhost:8000/rpc) and LENS_IT_FRIENDBOT_URL
 * (default: /friendbot on the same host) point it at a different node.
 */
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Address,
  Asset,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from '@stellar/stellar-sdk';
import { LensRpcClient, buildFilters, defaultCursorKey } from '@soroban-lens/ingest';
import { SqliteEventStore } from '@soroban-lens/store';
import { resolveConfig, runIndexer } from '../dist/index.js';

const RPC_URL = process.env.LENS_IT_RPC_URL ?? 'http://localhost:8000/rpc';
const FRIENDBOT_URL = process.env.LENS_IT_FRIENDBOT_URL ?? new URL('/friendbot', RPC_URL).href;
/** quickstart's `--local` network. */
const PASSPHRASE = 'Standalone Network ; February 2017';
const AMOUNT = 12_345_678n; // stroops; distinctive enough to find in the decoded value

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything the tests share, built once in `before`. */
const world = {};

async function waitForNode(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const health = await server.getHealth();
      // A fresh quickstart reports healthy before it has closed its first ledgers.
      if (health.status === 'healthy' && health.latestLedger > 2) return health;
      last = `status ${health.status}, ledger ${health.latestLedger}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(2000);
  }
  throw new Error(
    `No healthy Soroban RPC at ${RPC_URL} after ${timeoutMs / 1000}s (${last}). ` +
      'Start one with: docker compose -f docker-compose.integration.yml up -d',
  );
}

async function fund(keypair) {
  // Friendbot can race a node that only just became healthy, so retry briefly.
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${FRIENDBOT_URL}?addr=${keypair.publicKey()}`);
    if (res.ok) return;
    await sleep(2000);
  }
  throw new Error(`friendbot would not fund ${keypair.publicKey()} at ${FRIENDBOT_URL}`);
}

/** Simulate, sign, submit and wait for one operation. Returns the hash and the ledger it landed in. */
async function submit(source, operation) {
  const account = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(account, { fee: '1000000', networkPassphrase: PASSPHRASE })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(source);

  const sent = await server.sendTransaction(tx);
  assert.notEqual(sent.status, 'ERROR', `sendTransaction rejected: ${JSON.stringify(sent.errorResult)}`);
  const done = await server.pollTransaction(sent.hash, { attempts: 60, sleepStrategy: () => 1000 });
  assert.equal(done.status, 'SUCCESS', `transaction ${sent.hash} ended ${done.status}`);
  return { hash: sent.hash, ledger: done.ledger };
}

before(async () => {
  await waitForNode();

  const from = Keypair.random();
  const to = Keypair.random();
  await Promise.all([fund(from), fund(to)]);

  // The native asset's contract. A fresh local network may or may not already
  // have it deployed, so "already exists" is fine — either way its id is derived.
  const contractId = Asset.native().contractId(PASSPHRASE);
  try {
    await submit(from, Operation.createStellarAssetContract({ asset: Asset.native() }));
  } catch (error) {
    if (!/already exist|ExistingValue/i.test(String(error?.message ?? error))) throw error;
  }

  // Taken before the transfer, so the indexer starts at (or just before) it.
  const { sequence: startLedger } = await server.getLatestLedger();
  const transfer = await submit(
    from,
    new Contract(contractId).call(
      'transfer',
      new Address(from.publicKey()).toScVal(),
      new Address(to.publicKey()).toScVal(),
      nativeToScVal(AMOUNT, { type: 'i128' }),
    ),
  );

  Object.assign(world, { from, to, contractId, startLedger, transfer });
});

test('a real getEvents round trip returns the transfer, with base64 XDR and a usable cursor', { timeout: 120_000 }, async () => {
  const client = new LensRpcClient({ rpcUrl: RPC_URL, retry: { attempts: 5 } });

  let batch;
  for (let attempt = 0; attempt < 30; attempt++) {
    batch = await client.getEvents({
      filters: buildFilters([world.contractId]),
      startLedger: world.startLedger,
    });
    if (batch.events.some((e) => e.txHash === world.transfer.hash)) break;
    await sleep(1000); // the event index trails transaction success by a moment
  }

  const event = batch.events.find((e) => e.txHash === world.transfer.hash);
  assert.ok(event, 'the transfer event never appeared in getEvents');
  assert.equal(event.contractId, world.contractId);
  assert.equal(event.ledger, world.transfer.ledger);
  assert.ok(event.topic.length >= 3, 'transfer carries at least [name, from, to]');
  assert.ok(event.topic.every((t) => /^[A-Za-z0-9+/]+=*$/.test(t)), 'topics are base64 XDR');
  assert.match(event.value, /^[A-Za-z0-9+/]+=*$/);

  // A real cursor: resuming from it must not replay what was already read.
  const next = await client.getEvents({ filters: buildFilters([world.contractId]), cursor: batch.cursor });
  assert.ok(!next.events.some((e) => e.id === event.id), 'the cursor replayed an event it had already returned');
});

test('the indexer stores the contract\'s transfer event, decoded, and resumes from its cursor', { timeout: 240_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lens-integration-'));
  const dbPath = join(dir, 'lens.db');
  const config = resolveConfig(
    {
      network: 'testnet', // only a label here; the explicit rpcUrl wins
      rpcUrl: RPC_URL,
      contracts: [world.contractId],
      db: dbPath,
      dataDir: dir,
      startLedger: world.startLedger,
      pageSize: 50,
      pollInterval: 200,
    },
    { LENS_FETCH_SPECS: 'false' },
  );

  try {
    let first;
    for (let attempt = 0; attempt < 30; attempt++) {
      first = await runIndexer({ config, stopWhenCaughtUp: true, log: () => {} });
      if (first.seen > 0) break;
      await sleep(1000);
    }
    assert.ok(first.inserted >= 1, `the indexer stored nothing (seen ${first.seen})`);

    const store = new SqliteEventStore({ path: dbPath });
    try {
      const { events } = await store.queryEvents({ contractId: world.contractId, txHash: world.transfer.hash });
      assert.equal(events.length, 1, 'exactly one event for the transfer transaction');

      const [event] = events;
      assert.equal(event.decodeError, undefined, 'real XDR decoded cleanly');
      assert.equal(event.ledger, world.transfer.ledger);
      assert.deepEqual(event.topics[0], { type: 'symbol', value: 'transfer' });
      assert.deepEqual(event.topics[1], { type: 'address', value: world.from.publicKey() });
      assert.deepEqual(event.topics[2], { type: 'address', value: world.to.publicKey() });
      assert.deepEqual(event.value, { type: 'i128', value: AMOUNT.toString() });

      // Indexed by address (#23), so the sender finds it too.
      const byAddress = await store.queryEvents({ address: world.from.publicKey() });
      assert.ok(byAddress.events.some((e) => e.id === event.id));

      const cursor = await store.loadStreamState(defaultCursorKey(RPC_URL, [world.contractId]));
      assert.ok(cursor && cursor.cursor !== '', 'the indexer persisted its cursor');
    } finally {
      await store.close();
    }

    // Resuming from the stored cursor replays nothing.
    const second = await runIndexer({ config, stopWhenCaughtUp: true, log: () => {} });
    assert.equal(second.inserted, 0, 'a second run inserted duplicates');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
