import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  LensRpcClient,
  closeMetricsServer,
  measureClockSkew,
  resolveClockSkewThreshold,
  describeClockSkew,
  DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS,
} from '../dist/index.js';

const CLOSE = 1_900_000_000; // seconds

test('a local clock a few seconds behind the ledger is within the default threshold', () => {
  const skew = measureClockSkew(100, String(CLOSE), (CLOSE + 7) * 1000);
  assert.equal(skew.skewSeconds, 7);
  assert.equal(skew.exceedsThreshold, false);
  assert.equal(skew.thresholdSeconds, DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS);
  assert.equal(skew.ledgerCloseTime, new Date(CLOSE * 1000).toISOString());
});

test('the threshold is strict: exactly at it is fine, one second over warns', () => {
  assert.equal(measureClockSkew(1, CLOSE, (CLOSE + 60) * 1000, 60).exceedsThreshold, false);
  assert.equal(measureClockSkew(1, CLOSE, (CLOSE + 61) * 1000, 60).exceedsThreshold, true);
});

test('skew is reported in both directions', () => {
  const ahead = measureClockSkew(1, CLOSE, (CLOSE + 3600) * 1000);
  assert.equal(ahead.skewSeconds, 3600);
  assert.equal(ahead.exceedsThreshold, true);
  assert.match(describeClockSkew(ahead), /3600s ahead of ledger 1/);

  const behind = measureClockSkew(1, CLOSE, (CLOSE - 3600) * 1000);
  assert.equal(behind.skewSeconds, -3600);
  assert.equal(behind.exceedsThreshold, true);
  assert.match(describeClockSkew(behind), /3600s behind ledger 1/);
});

test('an unusable closeTime is an error, not a skew of zero', () => {
  for (const bad of ['', 'abc', 0, -5, NaN]) {
    assert.throws(() => measureClockSkew(1, bad, 0), /unusable closeTime/, String(bad));
  }
});

test('the threshold env value falls back to the default when unusable', () => {
  assert.equal(resolveClockSkewThreshold(undefined), DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS);
  assert.equal(resolveClockSkewThreshold(''), DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS);
  assert.equal(resolveClockSkewThreshold('abc'), DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS);
  assert.equal(resolveClockSkewThreshold('-1'), DEFAULT_CLOCK_SKEW_THRESHOLD_SECONDS);
  assert.equal(resolveClockSkewThreshold('300'), 300);
  assert.equal(resolveClockSkewThreshold('0'), 0);
});

test('LensRpcClient.clockSkew compares the local clock with getLatestLedger.closeTime', async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const { method, id } = JSON.parse(body);
    calls++;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: method === 'getLatestLedger' ? { id: 'x', sequence: 42, protocolVersion: 23, closeTime: String(CLOSE) } : {},
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new LensRpcClient({ rpcUrl: `http://127.0.0.1:${server.address().port}` });

    const fine = await client.clockSkew({ now: () => (CLOSE + 4) * 1000 });
    assert.equal(fine.latestLedger, 42);
    assert.equal(fine.skewSeconds, 4);
    assert.equal(fine.exceedsThreshold, false);

    const skewed = await client.clockSkew({ now: () => (CLOSE + 7200) * 1000, thresholdSeconds: 30 });
    assert.equal(skewed.exceedsThreshold, true);
    assert.equal(skewed.thresholdSeconds, 30);
    assert.equal(calls, 2);
  } finally {
    await closeMetricsServer(server);
  }
});

test('LensRpcClient.clockSkew makes a single attempt rather than retrying a failing endpoint', async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    calls++;
    request.resume();
    response.writeHead(503).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = new LensRpcClient({
      rpcUrl: `http://127.0.0.1:${server.address().port}`,
      retry: { attempts: 5, sleep: async () => {}, random: () => 0 },
    });
    await assert.rejects(client.clockSkew());
    assert.equal(calls, 1);
  } finally {
    await closeMetricsServer(server);
  }
});
