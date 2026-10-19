# Follow-up issues

One hundred scoped issues, twenty per module, tagged **trivial** / **medium** /
**high** by implementation effort — not by importance.

Every issue says what is wrong today, what to change, and how you know it
worked. They are grounded in code that exists: where an issue says "currently
hardcoded" or "stored but unused", that is a real line in this repo, not a
hypothetical.

**All 100 are also filed as GitHub issues, and the numbers match.** Issue #43
here is [issue #43 on GitHub](https://github.com/soroban-forge-labs/soroban-lens/issues/43).
This file is the readable index — one page, grouped by module, with the
cross-references between related issues intact. GitHub is where the discussion
and assignment happen. Labels there mirror this file: `module-1-ingest` …
`module-5-devx`, and `effort: trivial` / `medium` / `high`.

## Where to start

New here? These need one file each and have an obvious finished state:
[#13](https://github.com/soroban-forge-labs/soroban-lens/issues/13),
[#19](https://github.com/soroban-forge-labs/soroban-lens/issues/19),
[#29](https://github.com/soroban-forge-labs/soroban-lens/issues/29),
[#44](https://github.com/soroban-forge-labs/soroban-lens/issues/44),
[#61](https://github.com/soroban-forge-labs/soroban-lens/issues/61),
[#65](https://github.com/soroban-forge-labs/soroban-lens/issues/65),
[#66](https://github.com/soroban-forge-labs/soroban-lens/issues/66),
[#96](https://github.com/soroban-forge-labs/soroban-lens/issues/96) — or browse
the [`good first issue`](https://github.com/soroban-forge-labs/soroban-lens/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
label.

Looking for something newer? [Round two](#round-two) adds issues #126–#225.

Want to move the needle most? **#2** (no history past ~7 days) and **#22**
(SQLite is the only backend) are the two real ceilings on what soroban-lens can
do. **#62** (the UI has no behavioural tests) is the biggest quality gap.

| Module | Issues | trivial | medium | high |
|---|---|---|---|---|
| 1 — Ingestion & RPC (`packages/ingest`) | 1–20 | 10 | 7 | 3 |
| 2 — Decoding & Storage (`packages/store`) | 21–40 | 6 | 12 | 2 |
| 3 — Query API (`packages/api`) | 41–60 | 9 | 9 | 2 |
| 4 — Web UI (`apps/web`) | 61–80 | 11 | 8 | 1 |
| 5 — Deployment, Docs & DX (Module 5) | 81–100 | 10 | 6 | 4 |
| **Total** | **100** | **46** | **42** | **12** |

If you take one, say so on the issue first — several of these overlap and two
people solving #7 and #12 independently will conflict.

---

## Module 1 — Ingestion & RPC Client (`packages/ingest`) · Person A

### 1. Prometheus metrics endpoint — `medium`

The indexer is a black box while it runs. Expose an HTTP `/metrics` endpoint in
Prometheus text format: events ingested (counter), current ledger vs. network
latest (gauges — the difference is the lag people actually want to alert on),
RPC request duration (histogram), RPC errors by kind (counter), cursor restarts
after a retention gap (counter).

Keep it dependency-free; the format is simple enough to emit by hand, and a
client library would be the first runtime dependency in this package.

**Done when:** `curl localhost:9090/metrics` returns valid Prometheus text and a
scrape config in `docs/` shows how to alert on indexer lag.

### 2. Backfill from an archive source — `high`

RPC nodes retain ~7 days. Anything older is permanently unavailable, so a
contract deployed months ago cannot be fully indexed today — the largest
functional gap in v0.1.

Add an ingestion source that reads history from Stellar's public ledger archives
rather than from `getEvents`. Verify the current archive layout against the
official docs before designing this. It needs to share the cursor model with the
RPC poller so a backfill and a live tail can run against one database.

**Done when:** a contract with history older than the retention window can be
indexed from its first event, and `lens doctor` reports which source covers
which ledger range.

### 3. Handle ledger reorgs — `medium`

Events are written as they arrive and never revisited. Stellar's consensus makes
deep reorgs very unlikely, but "very unlikely" is not "impossible", and right
now a reorg would leave permanently wrong rows with no way to detect them.

Re-poll the most recent N ledgers on each cycle and compare event ids against
what is stored. Deletions and changes should be logged loudly; N should be
configurable and default to something small.

**Done when:** a test using a scripted fake RPC that changes history proves the
stored rows converge on the new truth.

### 4. Expose system events — `trivial`

`buildFilters()` in `rpc-client.ts` hardcodes `type: 'contract'`. `RawEvent.type`
already allows `'system'`, and the RPC serves both, so system events are
silently unreachable through this package.

Thread an event-type option through `PollerOptions` and add `--type` to the
ingest CLI.

**Done when:** `--type system` streams system events and the default behaviour
is byte-for-byte unchanged.

### 5. Expose topic filters on the CLI — `trivial`

`PollerOptions.topics` and `buildFilters()` both support topic filtering, and
`bin.ts` never passes it. Server-side topic filtering is the cheapest way to cut
ingestion volume and it is currently unreachable from the command line.

Add a repeatable `--topic` flag taking base64 ScVals or `*`.

**Done when:** `--topic <base64> --topic '*'` reaches the RPC filter, and the
help text explains the 4-segment ceiling.

### 6. Expose retry tuning — `trivial`

`RetryOptions` supports `attempts`, `baseDelayMs` and `maxDelayMs`. None are
reachable from the CLI or environment, so the defaults are effectively hardcoded
for every operator regardless of how flaky their RPC provider is.

**Done when:** `--retry-attempts`, `--retry-base-delay` and `--retry-max-delay`
work and are documented in `.env.example`.

### 7. Expose custom RPC headers — `trivial`

`RpcClientOptions.headers` exists because commercial RPC providers authenticate
with a header, but nothing surfaces it. Anyone using a paid provider has to
patch the source.

Add `--rpc-header 'Name: value'` (repeatable) and `LENS_RPC_HEADERS`.

**Done when:** an authenticated provider works without code changes, and the
header values are redacted in logs and in `lens doctor` output.

### 8. Validate contract ids before the first RPC call — `trivial`

`lens doctor` validates contract id shape, but the ingest package does not.
Running `soroban-lens-ingest -c GABC…` sends a doomed request and surfaces
whatever the RPC says, which is usually less clear than "that is an account id".

**Done when:** malformed ids fail before any network call, with the same message
`lens doctor` gives.

### 9. Add `--end-ledger` — `trivial`

`GetEventsArgs.endLedger` is plumbed through the client and never exposed.
Indexing a bounded historical range — a single incident, a single day — means
watching the log and killing the process.

**Done when:** `--end-ledger N` exits cleanly once the range is exhausted, and
combining it with `--cursor`-based resume is rejected with a clear error.

### 10. Report ingestion lag in `PollerProgress` — `trivial`

`PollerProgress` carries `ledger` and `latestLedger`; every consumer computes
the difference itself. Put `lagLedgers` and an estimated `lagSeconds` (ledgers ×
~5s) on the struct so the CLI, the metrics endpoint (#1) and the API agree on
one definition.

**Done when:** all three report the same number, and the estimate is documented
as an estimate.

### 11. Dedupe within a batch before yielding — `trivial`

Deduplication happens at the storage layer via `INSERT OR IGNORE`. Any consumer
that is not Module 2 — the NDJSON stdout path, for one — sees duplicates after a
replay and has to handle them itself.

Track ids seen in the current cursor window and drop repeats before yielding.

**Done when:** a replayed batch emits each event once on stdout, and storage
dedup still works as the backstop.

### 12. Multiple RPC endpoints with failover — `high`

One `rpcUrl`, so a provider outage stops ingestion entirely until a human
notices. This is the single biggest operational weakness for anyone running
soroban-lens unattended.

Accept an ordered list, health-check them, fail over on repeated errors, and
fail back when the primary recovers. Cursors are provider-specific in principle,
so verify that a cursor from one node is accepted by another before assuming it
is portable — if it is not, failover has to fall back to a ledger number.

**Done when:** killing the primary endpoint mid-stream continues ingestion
against the secondary with no gap and no duplicates.

### 13. Honour `429` and `Retry-After` — `trivial`

`withRetry` treats every failure identically with full-jitter backoff. A
rate-limited provider tells you exactly how long to wait in `Retry-After`, and
ignoring it means backing off either too little (more 429s) or too much.

**Done when:** a `429` carrying `Retry-After` waits precisely that long, and a
test with a scripted client proves it.

### 14. Adaptive page size — `medium`

`pageSize` is fixed at 200. A quiet contract wastes round trips; a busy one
could pull 10 000 per request. Neither is knowable in advance.

Grow the page size while pages come back full and fast, shrink it on timeouts or
slow responses, within configured bounds.

**Done when:** a benchmark shows fewer round trips on a busy contract with no
increase in error rate, and the bounds are configurable.

### 15. Parallelise across filter chunks — `medium`

`buildFilters()` splits more than five contract ids across multiple filters, but
`getEvents` sends them in one request and the poller advances one cursor. For
large contract sets this serialises work that could overlap.

Investigate whether per-chunk cursors are workable; if they are, poll chunks
concurrently with a bounded pool.

**Done when:** indexing 25 contracts is measurably faster, ordering guarantees
are documented, and the single-contract path is unchanged.

### 16. Structured JSON logging — `medium`

Logging is freeform strings through a `log(message: string)` callback. Useful to
a human watching a terminal, useless to anything parsing it.

Move to structured records (level, event, ledger, cursor, duration) with a text
renderer for humans and JSON for `LENS_LOG_FORMAT=json`.

**Done when:** `LENS_LOG_FORMAT=json` emits one JSON object per line, the
default output is unchanged, and the store and API use the same logger.

### 17. Persist and compare retention state — `medium`

`LensRpcClient.retention()` returns `latestLedger`/`oldestLedger`, and the two
close-time fields are returned as empty strings — a stub that looks like data.
Either populate them from `getHealth` or drop them from the type.

Then persist the observed window so a restart can say "this node moved its
oldest ledger past your cursor while you were down" rather than discovering it
mid-stream.

**Done when:** `RetentionState` has no fake fields, and restarting after a long
outage warns about the gap before any events are fetched.

### 18. Detect clock skew — `medium`

`ledgerClosedAt` is trusted as-is and converted to a Unix timestamp on insert. A
badly skewed local clock silently produces nonsense in any time-based query
built on it (#40), and nothing notices.

Compare local time against `latestLedgerCloseTime` at startup and warn beyond a
threshold.

**Done when:** `lens doctor` reports skew, and a skew over the threshold is a
warning rather than a silent wrong answer.

### 19. Warn when a page hits the RPC ceiling — `trivial`

A response of exactly `limit` events is treated purely as "not caught up". It
can also mean the request straddled a ledger with more events than the page
size, which is worth knowing when tuning #14.

**Done when:** hitting the 10 000 ceiling logs a distinct warning naming the
ledger.

### 20. Integration test against a local quickstart node — `high`

Every ingest test uses a scripted fake client. That is the right call for
retention-gap and reorg simulation, but it means no test has ever exercised a
real JSON-RPC round trip, real XDR off the wire, or a real cursor.

Add an opt-in suite against `stellar/quickstart` in Docker, deploying a tiny
contract and asserting its events are indexed. Keep it out of the default `npm
test` so the offline guarantee holds.

**Done when:** `npm run test:integration` passes locally and in a nightly CI
job, and the default suite still needs no network.

---

## Module 2 — Decoding & Storage (`packages/store`) · Person B

### 21. Prune command and retention policy — `trivial`

An indexer left running on a busy contract grows without bound, and there is no
supported way to prune.

Add `pruneBefore(ledger: number): Promise<number>` to `EventStore`, implement it
for SQLite (delete plus `VACUUM`), and expose it as `lens prune --before-ledger`.

**Done when:** pruning reduces the file size on disk, and a test confirms rows
below the threshold are gone while the stream cursor is untouched.

### 22. Postgres storage backend — `high`

SQLite is the right default and the wrong choice for several indexers writing
concurrently, or for a dataset past a few tens of GB.

Implement `EventStore` against Postgres. The trait exists precisely for this, so
no code above Module 2 should change. Reuse `decodeEvent()` — decoding is
backend-independent. Port the migrations, and use `JSONB` for `topics_json` and
`value_json` so topic containment queries can be indexed with GIN.

**Done when:** the existing store suite passes against both backends from one
parameterised run (#38), and `docker-compose.postgres.yml` demonstrates it.

### 23. Index events by decoded address — `medium`

"Every transfer involving account G…" is the single most common question people
ask of a contract, and today it needs a full scan plus client-side filtering.

Addresses appear in topics *and* nested inside values. Extract every address
from a decoded event into a side table (`event_id`, `address`, `position`) and
add a query filter for it.

**Done when:** `GET /events?address=G…` returns every event mentioning that
address anywhere, and a benchmark over ≥1M rows shows it uses the index.

### 24. Use `closed_at_unix` for time queries — `trivial`

The column is populated on every insert and read by nothing. `EventQuery` has no
time bounds at all, so "events from last Tuesday" means converting timestamps to
ledger numbers by hand.

Add `fromTime`/`toTime` to `EventQuery`, backed by the existing column, and
index it.

**Done when:** time-bounded queries work end to end, or the column is dropped in
a migration — either is better than a field that only looks useful.

### 25. Re-decode rows that failed to decode — `medium`

`decodeEvent()` deliberately never throws: a bad event is stored with
`decodeError` set and its raw XDR intact, explicitly so it can be re-decoded
after a fix. Nothing implements the re-decoding.

Add `lens redecode` that re-runs the decoder over rows with `decode_error IS NOT
NULL` (and optionally over everything, after a decoder change).

**Done when:** a deliberately corrupted row is repaired in place after the
decoder is fixed, without re-indexing from the network.

### 26. Cache the total count — `medium`

`queryEvents` runs `COUNT(*)` with the full `WHERE` clause on every single
request, alongside the page query. On a large table that dominates the response
time, and the UI displays the number in a place where approximate is fine.

Cache per filter with a short TTL, or return an estimate above a threshold and
mark it as one.

**Done when:** a benchmark over ≥1M rows shows a large drop in query time, and
the API tells clients when a count is estimated.

### 27. Batch insert performance — `medium`

`insertDecoded` runs one `stmt.run()` per event inside a transaction. That is
correct, and it is not obviously fast. Nobody has measured it.

Benchmark it, then try multi-row `VALUES` batching and `PRAGMA` tuning.

**Done when:** a documented benchmark exists and either shows a real improvement
or records that the current approach is already fine — a measurement either way
is the deliverable.

### 28. WAL checkpoint management — `medium`

WAL mode is on with no checkpoint policy. A continuously-writing indexer with a
long-lived reader can grow `-wal` without bound, which looks like a disk leak.

Add periodic `wal_checkpoint(TRUNCATE)` and expose WAL size in stats.

**Done when:** a long soak test shows the WAL file staying bounded.

### 29. Report database size in `getStats` — `trivial`

`StoreStats` has counts and ledger ranges but nothing about size on disk, which
is the first thing anyone asks when a volume fills up.

Add `sizeBytes` (and WAL size, alongside #28), and surface it in `lens stats`
and `GET /stats`.

**Done when:** the reported size matches `du` on the database file.

### 30. Add a `countByTopic` aggregate — `trivial`

`listTopics` already groups by `topic0` for one contract. There is no global
equivalent, so "what event types exist across everything indexed" requires
paging the whole table.

**Done when:** `EventStore.countByTopic()` exists and `GET /stats` includes the
top topics across all contracts.

### 31. Query by transaction and operation index — `trivial`

`transaction_index` and `operation_index` are stored and indexed by nothing.
`EventQuery` cannot filter on them, so reconstructing the exact event order
inside one transaction means fetching by `txHash` and sorting client-side.

**Done when:** both are filterable, and `GET /events?txHash=…&operationIndex=0`
works.

### 32. Full-text search over decoded values — `medium`

Finding an event by something inside its payload means fetching and scanning
client-side.

Add an SQLite FTS5 virtual table over the decoded JSON, kept in sync by trigger,
and a `search` query parameter.

**Done when:** searching a substring of a decoded value returns the right events
on a table of ≥1M rows in reasonable time, and the index rebuild is documented.

### 33. Store contract specs for typed decoding — `high`

Events decode to generic ScVal shapes: a map with keys, a vec of values. With
the contract's spec, `{"amount":"100","to":"G…"}` could carry real field names
and types.

Fetch and store contract specs, then offer spec-aware decoding as an additional
view that never replaces the generic one.

**Done when:** an event from a contract with a known spec shows named, typed
fields, and a contract without a spec is unaffected.

### 34. Handle ScVal arms `scValToNative` does not cover — `medium`

`decodeScVal` derives its type tag from the constructor name and delegates the
value to `scValToNative`. Protocol upgrades add arms. Today an unknown arm
either throws into `decodeError` or produces something unhelpful, and we would
find out from a user.

Enumerate the arms in the current XDR definitions, add a test asserting each one
decodes, and make unknown arms degrade to a documented shape.

**Done when:** every arm in the current protocol has a decode test, and a new
arm produces a clear `decodeError` rather than a crash.

### 35. Compress the raw XDR columns — `medium`

`value_xdr` and `topics_xdr_json` store base64 — roughly a third larger than the
bytes they encode — and are read rarely, mostly by the UI's "Raw XDR" panel.

Store them as compressed blobs and decompress on read.

**Done when:** a documented benchmark shows the size reduction and quantifies
the read cost, so the trade can be judged rather than assumed.

### 36. Index `indexed_at` — `trivial`

The column is written on every row and has no index, so "what did we ingest in
the last hour" — the natural question when debugging a stalled indexer — is a
full scan.

**Done when:** the index exists in a new migration and a query ordering by
`indexed_at` uses it.

### 37. Snapshot export and import — `medium`

Sharing an indexed dataset, or seeding a new instance from an old one, means
copying the SQLite file and hoping nothing was mid-write.

Add `lens export` / `lens import` using SQLite's backup API (or `VACUUM INTO`)
for a consistent snapshot, in a format that survives a backend change.

**Done when:** a snapshot taken while the indexer is running restores to an
identical event set.

### 38. Parameterised suite for any `EventStore` — `medium`

`test/sqlite-store.test.js` is written against the trait but instantiates
`SqliteEventStore` directly, so a second backend (#22) cannot reuse it without a
copy-paste.

Extract the behavioural assertions into a suite taking a factory.

**Done when:** one exported function validates any `EventStore`, SQLite runs
through it, and the Postgres work can adopt it unchanged.

### 39. Detect and repair corrupt rows — `medium`

Nothing verifies that stored rows are internally consistent —
`topics_json` matching `topic_count`, `topic0..3` matching `topics_json`, JSON
columns parsing at all.

Add `lens verify` to check invariants and report (with `--repair` to recompute
derived columns from the raw XDR).

**Done when:** a row with a hand-corrupted `topic0` is detected and repaired.

### 40. Migration rollback — `medium`

Migrations are forward-only. A bad migration on a production database currently
has no supported path back except restoring a backup.

Add optional `down` SQL and `lens migrate --down --to <version>`, with the
append-only rule for `up` unchanged.

**Done when:** a migration can be applied and rolled back in a test, and the
docs say plainly which migrations are irreversible.

---

## Module 3 — Query API (`packages/api`) · Person C

### 41. CSV export — `trivial`

Getting indexed events into a spreadsheet or a pandas notebook currently means
writing a jq incantation.

Support `Accept: text/csv` and `?format=csv` on both event-list routes. Flatten
topics to `topic0..topicN` columns and the value to its JSON text. Stream the
response rather than buffering — an export can be far larger than a page.

Quote `i128` values so spreadsheets do not coerce them into floats and destroy
the precision the API went out of its way to preserve.

**Done when:** `curl -H 'Accept: text/csv' …/events > out.csv` opens correctly,
and a test asserts large integers survive a round trip.

### 42. Server-sent events for live updates — `medium`

The UI polls every 5 seconds: latency nobody wants and load nobody needs.

Add `GET /events/stream` as an SSE endpoint accepting the same filters, emitting
each new event as it is indexed. Include the last event id in each message so a
dropped connection can resume with `Last-Event-ID` rather than re-reading.

**Done when:** the UI switches to SSE with polling as a fallback, and the server
handles 100 concurrent streams without unbounded memory growth.

### 43. Rate limiting and optional API keys — `medium`

The API is unauthenticated with `Access-Control-Allow-Origin: *`. That is a
reasonable default for localhost and an unreasonable one for anything reachable.

Add a token-bucket limiter keyed by client IP, plus optional API keys via
`LENS_API_KEYS`. Both off by default — the local experience must not regress.
Return `429` with `Retry-After`, and document the whole thing in `openapi.json`
with a `security` scheme.

**Done when:** a load test confirms limits are enforced, keys gate access when
configured, an unconfigured instance behaves exactly as today, and
`security-defined` can be re-enabled in `redocly.yaml`.

### 44. Response compression — `trivial`

Every response is uncompressed JSON. A 1000-event page is largely repeated field
names and base64, which gzip handles extremely well.

Add gzip/deflate based on `Accept-Encoding`, using `node:zlib`, with a minimum
size threshold.

**Done when:** a large page is materially smaller over the wire and a client
sending no `Accept-Encoding` still gets valid JSON.

### 45. Serve interactive API docs — `trivial`

`/openapi.json` is served as raw JSON. Newcomers get a wall of text where a
browsable page would answer their question.

Serve Redoc or Swagger UI at `/docs`, pinned to a CDN version — with the
existing CSP-free posture this is a `<script src>` and a div.

**Done when:** `/docs` renders the live spec and the quickstart links to it.

### 46. Structured request logging with request ids — `trivial`

The access log is a formatted string, and nothing correlates a client error
report with a server-side log line.

Generate a request id, return it as `X-Request-Id`, include it in every log
record for that request, and share the structured logger from #16.

**Done when:** an error response carries an id that finds every related log line.

### 47. ETag and conditional requests — `medium`

The UI re-fetches the same first page every 5 seconds, and the server serialises
and sends it in full every time even when nothing changed.

Emit an `ETag` derived from the newest event id and the filter, and honour
`If-None-Match` with `304`.

**Done when:** an unchanged poll returns `304` with no body, and the UI's
polling traffic drops sharply.

### 48. `prevCursor` for backwards pagination — `medium`

Pagination is forward-only: `nextCursor` and nothing else. A UI that has paged
forward cannot page back without re-walking from the start.

Add `prevCursor` to `EventPage`, and support a direction flag in the store's
keyset query.

**Done when:** paging forward then back returns the original page exactly, with
a test walking both directions.

### 49. `/contracts/{id}/stats` — `trivial`

Getting one contract's event count, ledger range and last-seen time means
fetching `/contracts` and filtering client-side. `listContracts` already
computes exactly this per contract.

**Done when:** the route returns that summary and 404s for a contract with no
indexed events (see #58).

### 50. Batch fetch events by id — `trivial`

`GET /events/{id}` is one round trip per event. A client resolving a list of ids
— from a log, from an export — makes N requests.

Add `GET /events?ids=a,b,c` with a documented ceiling.

**Done when:** a batch request returns the events in the order asked, with
missing ids reported rather than silently dropped.

### 51. `HEAD` support — `trivial`

The router matches on exact method, so `HEAD /health` returns `405` where any
HTTP client would expect the `GET` headers with no body. Monitoring tools use
`HEAD` routinely.

**Done when:** `HEAD` works on every `GET` route, returning identical headers
and an empty body.

### 52. Sparse field selection — `medium`

Every response includes `topicsXdr` and `valueXdr`, which roughly double the
payload and which most clients never read — the UI shows them only in a
collapsed panel.

Add `?fields=` to select which to return, defaulting to everything for
compatibility.

**Done when:** `?fields=id,ledger,topics,value` measurably shrinks the response
and the default is unchanged.

### 53. Time-bucketed aggregate endpoint — `medium`

Answering "how many events per hour this week" means paging every event and
counting client-side.

Add `GET /contracts/{id}/activity?bucket=hour&from=…&to=…` returning counts per
bucket, built on #24.

**Done when:** the endpoint returns correct counts and #75's chart is built on
it rather than on raw events.

### 54. Publish a generated client to npm — `medium`

The README tells people to generate their own client from `openapi.json`. That
is fine, and a published, versioned package is what most people actually want.

Generate a typed TS client in CI and publish it alongside the release (#83).

**Done when:** `npm i @soroban-lens/client` gives a typed client whose version
tracks the spec, and drift fails CI.

### 55. Configurable query limit — `trivial`

`MAX_QUERY_LIMIT` is a hardcoded 1000. An operator running this on a big machine
for internal use has no way to raise it; the API rejects the request with a
message about a constant they cannot change.

**Done when:** `LENS_MAX_QUERY_LIMIT` works, defaults to 1000, and is reflected
in the served spec.

### 56. Graceful shutdown that drains requests — `medium`

`SIGTERM` calls `server.close()` and then closes the store, without waiting for
in-flight handlers. Under load a rolling restart can close the database out from
under a request being served.

Track in-flight requests, stop accepting new ones, drain with a timeout, then
close.

**Done when:** a restart under sustained load produces zero failed responses.

### 57. `503` with `Retry-After` during migrations — `trivial`

If the schema is behind, `/health` reports `degraded` while every data route
keeps serving from a half-migrated database.

Return `503` with `Retry-After` from data routes while a migration is pending.

**Done when:** a store at an older schema version serves `503` on data routes
and still answers `/health` with the reason.

### 58. Distinguish "no such contract" from "no events" — `medium`

`GET /contracts/{id}/events` returns an empty page for a contract that is not
indexed, for a contract that is indexed but quiet, and for a valid id that has
never existed. Three very different situations, one response.

Return `404` when the contract has never been seen, and an empty page with an
explanatory field when it is known but has no matching events.

**Done when:** the three cases are distinguishable, and the UI's empty state
(#78) uses the distinction.

### 59. Webhook subscriptions — `high`

Reacting to an event means polling. Every consumer reimplements the same loop.

Let clients register a URL plus filter, and POST matching events to it with
retries, a signature header, and a dead-letter record after repeated failure.

**Done when:** a registered webhook receives matching events, survives a
receiver being down, and cannot be used to make the server flood a third party.

### 60. GraphQL endpoint — `high`

The REST shape is fixed. Clients wanting one field per event, or events joined
to contract summaries, over-fetch or make several calls.

Add an optional `/graphql` over the same `EventStore`, disabled by default.
Guard against unbounded queries with depth and complexity limits.

**Done when:** the schema covers events, contracts and topics, REST is
untouched, and a query-complexity test proves the limits hold.

---

## Module 4 — Web UI (`apps/web`) · Person D

### 61. Dark mode — `trivial`

The CSS already uses custom properties on `:root`, so this is mostly one
`@media (prefers-color-scheme: dark)` block redefining the palette.

Add an explicit toggle as well — respecting the system setting is right by
default, but people reading a terminal-adjacent tool often want to override it.
Persist the choice in `localStorage` next to the existing UI state.

**Done when:** both themes are legible (contrast ≥ 4.5:1 for body text), the
toggle overrides the system setting in both directions, and there is no flash of
the wrong theme on load.

### 62. Component tests — `medium`

The UI has no test runner. `npm test` runs the production build, which
type-checks but proves nothing about behaviour. **This is the most valuable
contribution anyone could make to this module.**

Add Vitest with Testing Library. Cover the cases most likely to break quietly:
`summarise()` and `truncate()`, the topic-prefix query builder, row expansion,
the request-versioning logic that stops a slow response overwriting a newer one,
and the network-mismatch warning.

**Done when:** `npm test -w @soroban-lens/web` runs real component tests in CI
and covers each item above.

### 63. Shareable URLs and deep links — `medium`

Filter state lives in `localStorage`, so you cannot send a colleague a link to
what you are looking at — the main thing anyone wants from an explorer.

Move contract, topic, network and expanded-event state into the query string,
with `localStorage` only as the fallback for a bare visit. Add `/events/{id}` as
a route that opens that event expanded.

**Done when:** copying the URL reproduces the exact view in a fresh browser, and
back/forward move through filter history.

### 64. Virtualise the table — `medium`

"Load more" appends 50 rows at a time into a plain `<table>` with no ceiling.
Several thousand rows of expandable DOM will make scrolling miserable, and it is
easy to get there on a busy contract.

Add row virtualisation, keeping expansion and keyboard navigation (#69) working.

**Done when:** 10 000 loaded rows scroll smoothly, with a measurement recorded.

### 65. Copy buttons for ids and hashes — `trivial`

Contract ids, tx hashes and event ids are displayed truncated with the full
value in a `title` attribute. Copying one means expanding the row and selecting
text precisely — and a mis-selected 56-character StrKey is a silent wrong query.

Add copy-to-clipboard buttons with visible confirmation.

**Done when:** every truncated identifier can be copied in one click, including
from the collapsed row.

### 66. Link out to a block explorer — `trivial`

The UI shows a tx hash and stops. Investigating almost always means going to
Stellar Expert or Horizon, which right now is copy, switch tab, paste.

Add per-network outbound links for transactions, contracts and accounts, driven
by a config map so self-hosted explorers work too.

**Done when:** transaction and contract links open the right page for the
selected network, and an unknown network simply shows no link.

### 67. Absolute vs relative timestamps — `trivial`

Rows show only `relativeTime()` — "3h ago". Correlating with a log or a support
ticket needs the actual timestamp, which today means expanding the row.

Add a toggle, and a `title` with the exact time on the relative form.

**Done when:** the toggle switches every row, persists, and the exact time is
always available on hover.

### 68. Ledger range filter in the UI — `trivial`

`fromLedger`/`toLedger` work in the store and the API and appear nowhere in the
interface, so narrowing to an incident window means hand-writing a curl.

**Done when:** ledger bounds are settable in the UI, validated as integers, and
included in the shareable URL from #63.

### 69. Keyboard navigation — `medium`

Rows are `<tr>` elements with an `onClick`. There is no `tabindex`, no `role`,
and no key handling, so the table is unusable without a mouse and invisible to
assistive technology.

Make rows focusable, support arrow keys, Enter/Space to expand, Escape to
collapse, and `/` to focus the contract field.

**Done when:** the whole table is operable from the keyboard, with correct
`aria-expanded` and focus management.

### 70. Accessibility audit — `medium`

Beyond #69: colour contrast has never been measured, the live-updating table has
no `aria-live` announcement, and the topic chips inside clickable rows are
nested interactive controls.

Run axe, fix what it finds, and add a CI check.

**Done when:** axe reports no violations on the main view in both themes, and
the check runs in CI.

### 71. Export the current view — `trivial`

Getting the filtered set out means rebuilding the same filters against the API
by hand.

Add an export button producing CSV or JSON for the current filters, using #41.

**Done when:** the export matches exactly what the filters describe — not just
the rows currently loaded — and says so if it is truncated.

### 72. Error boundary — `trivial`

One render error in `EventRow` — an unexpected payload shape from an unusual
contract — unmounts the whole app and leaves a blank page with no explanation.

Add an error boundary with a readable fallback and a reload affordance.

**Done when:** a component throwing on one row leaves the rest of the page
usable, and the error is visible rather than silent.

### 73. Loading skeletons — `trivial`

The empty state renders the word "Loading…", so switching contracts flashes an
empty box. It reads as "nothing here" rather than "working".

Add skeleton rows, and keep previous results visible while refetching.

**Done when:** changing filters no longer flashes an empty table.

### 74. Contract picker — `trivial`

The contract field is free text, while `/contracts` already lists everything
indexed with event counts. New users have to find a contract id elsewhere before
the tool shows them anything.

Add a dropdown of indexed contracts, keeping free text for anything else.

**Done when:** a user with a populated database can pick a contract without
typing, showing counts and last activity.

### 75. Activity chart — `medium`

Spotting a burst or a gap means reading timestamps down a table.

Add a small events-per-bucket chart above the table, backed by #53, with
click-to-filter on a bucket.

**Done when:** the chart matches the active filters and clicking a bucket
narrows the ledger range.

### 76. Keep rows expanded when they leave and re-enter the page — `trivial`

`EventRow` keeps `expanded` in its own `useState`. Rows are keyed by `event.id`,
so React does preserve that correctly across a live refresh — the state is only
lost when the component unmounts.

Which it does, routinely: `loadFirstPage` replaces the whole list every 5
seconds, so on a busy contract an expanded row gets pushed off the first page by
newer events, unmounts, and silently returns collapsed. Changing a filter and
changing back does the same.

Lift expansion into a set of event ids held by the parent.

**Done when:** a row expanded, then pushed off the first page by new events,
then brought back into view, is still expanded.

### 77. Bundle size budget — `trivial`

The bundle is ~236 kB and nothing watches it. A casual dependency could double
it and nobody would notice until a user on a slow link complained.

Add a CI check against a committed budget.

**Done when:** exceeding the budget fails CI with the before/after sizes.

### 78. Honest empty and error states — `medium`

The empty state guesses: it shows "Nothing indexed yet" whenever the store is
empty, even when the real cause is a filter matching nothing, an unreachable
API, or an indexer still working through history.

Use `/status` and #58 to tell the user which of those it actually is, and what
to do about each.

**Done when:** all four states produce distinct, accurate messages.

### 79. Internationalisation scaffolding — `medium`

Every string is inline in JSX. Translating anything means touching every
component, so in practice nobody will.

Extract strings into a catalogue with a minimal `t()` and a locale switch.
English only to start — the point is that the second language is cheap.

**Done when:** no user-facing string is inline, and a stub locale demonstrates
switching.

### 80. Compare two events side by side — `high`

Debugging "why did this call behave differently from that one" means expanding
two rows far apart and scrolling between them.

Add multi-select and a diff view highlighting differing topics and value fields,
with structural diffing for maps and vecs.

**Done when:** two events can be compared with differences highlighted, and the
comparison is linkable via #63.

---

## Module 5 — Deployment, Docs & DX (`packages/cli`, `deploy/`, `docs/`) · Person E

### 81. `lens doctor --fix` for common failures — `trivial`

Doctor diagnoses and then leaves you to it. Several failures have one obvious
remedy: create a missing data directory, run pending migrations, write a `.env`
from `.env.example`.

Add `--fix` to apply exactly those, printing each action. Never touch anything
destructive, and never guess at network configuration.

**Done when:** a fresh clone with no `.env` and no `data/` reaches all-green
from a single `lens doctor --fix`.

### 82. Multi-network compose profile — `medium`

Running testnet and mainnet side by side is a supported idea — the UI has a
network switcher — but nothing in `deploy/` sets it up, so the switcher ships
with one entry.

Add compose profiles running a second indexer/API pair against mainnet on a
separate volume and port, with `LENS_WEB_NETWORKS` wired to both. Document that
mainnet needs a user-supplied `LENS_RPC_URL`.

**Done when:** `docker compose --profile mainnet up` yields a UI whose switcher
moves between two live networks.

### 83. Publish images and a release workflow — `high`

Installing means cloning and building. There is no released artifact, so there
is no way to pin a version or roll one back.

Add a tag-triggered workflow that builds multi-arch images (amd64 + arm64),
publishes to GHCR, publishes the packages to npm, generates a changelog from
conventional commits, and attaches the OpenAPI spec to the GitHub release.
Provide a `docker-compose.release.yml` that pulls published images rather than
building.

**Done when:** `docker compose -f docker-compose.release.yml up` works on a
machine that has never cloned the repo, on both architectures.

### 84. Healthcheck for the indexer container — `trivial`

The `api` service has a healthcheck; `indexer` has none. A wedged indexer that
has not advanced its cursor in an hour still reports as `Up`, which is the exact
failure most worth catching.

Add a healthcheck comparing the stored cursor's `updatedAt` against a threshold.

**Done when:** an indexer that stops advancing is reported unhealthy, and a
legitimately quiet contract is not.

### 85. Check disk space in `lens doctor` — `trivial`

Doctor checks that the data directory is writable, not that there is room. A
volume with 10 MB free passes every check and then fails at 3am.

Warn below a configurable threshold, and include the current database size
(#29).

**Done when:** a nearly-full volume produces a warning with the numbers, and
`--fix` never tries to delete anything.

### 86. `lens tail` — follow events in the terminal — `medium`

Watching events live means running the API and opening a browser. For someone
already in a terminal deploying a contract, that is a lot of ceremony.

Add `lens tail` that follows new events for a contract with readable
colourised output, `--json` for piping, and the same filters as the API.

**Done when:** `lens tail -c C… --topic transfer` prints matching events as they
are indexed, and `--json | jq` works.

### 87. Shell completions — `trivial`

The CLI has a lot of flags and no completion, so `--start-ledger` versus
`--startLedger` is a guess every time.

Generate bash, zsh and fish completions via `lens completions <shell>`.

**Done when:** completions work in all three shells and installation is
documented.

### 88. Issue and PR templates — `trivial`

CONTRIBUTING.md asks for the module and the user-visible symptom. Nothing
prompts for either at the moment someone files, so most reports will omit them.

Add `.github/ISSUE_TEMPLATE/` forms for bug and feature, a PR template with the
module-prefix convention, and `CODEOWNERS` matching the ownership map.

**Done when:** filing an issue prompts for module, network and version, and
`CODEOWNERS` routes reviews to the right owner.

### 89. Dependency update automation — `trivial`

Dependencies are pinned and nothing watches them. `@stellar/stellar-sdk` tracks
protocol releases closely, so this project goes stale faster than most.

Add Renovate or Dependabot, grouping dev dependencies and flagging SDK updates
individually for review.

**Done when:** update PRs open automatically and run the full CI suite.

### 90. Security scanning in CI — `trivial`

No CodeQL, no `npm audit`, no image scanning — on a public repo that ingests
untrusted data from the network.

Add CodeQL for JS/TS, `npm audit` at a sensible threshold, and Trivy on the
built images.

**Done when:** all three run on pull requests and a known-vulnerable dependency
fails the build.

### 91. Backup and restore — `medium`

`docs/troubleshooting.md` explains how to delete everything and start over. It
says nothing about keeping anything, and re-indexing cannot recover data past
the retention window — so a lost volume can be permanent data loss.

Document a backup procedure using #37, add `lens backup`/`lens restore`, and
cover the Docker volume case.

**Done when:** a documented procedure restores a working instance from a backup
taken while the indexer was running.

### 92. Shrink the runtime image — `medium`

`Dockerfile.node` is single-stage: source, dev dependencies and the TypeScript
compiler all ship in the final image. The web image is already multi-stage and
much smaller.

Split build and runtime, copying only `dist/` and production dependencies.

**Done when:** the image is substantially smaller with the before/after recorded,
and all four services still work.

### 93. Log rotation and retention guidance — `trivial`

The indexer logs a line per batch, forever, with no rotation configured and no
mention of it in the docs. On a busy contract that fills a disk.

Configure compose logging limits and document the systemd and Kubernetes cases.

**Done when:** the default compose setup cannot fill a disk with logs, and the
docs say how to change it.

### 94. Architecture decision records — `medium`

`docs/architecture.md` explains the current design well. It does not record what
was rejected, so every future contributor re-litigates SQLite, polling, and the
duplicated `RawEvent` type from scratch.

Add short ADRs for the decisions already made, and a template for new ones.

**Done when:** each major decision has an ADR stating the alternatives and why
they lost.

### 95. Systemd units — `trivial`

Docker and bare `npm run` are documented. Running this as a service on a plain
VM — a very normal thing to want — is left as an exercise.

Add `deploy/systemd/` units for indexer and API, with hardening directives and
an install guide.

**Done when:** both services install, start on boot, restart on failure, and run
unprivileged.

### 96. Screenshot and demo in the README — `trivial`

The README describes a UI that nobody can see without cloning and building.
For a public repo, that is the difference between a project people try and one
they scroll past.

Add a screenshot and a short demo GIF of indexing a testnet contract.

**Done when:** the README shows the UI above the fold and the images are
committed at a sensible size.

### 97. Kubernetes manifests and a Helm chart — `high`

Compose is the only supported deployment. Anyone running this alongside other
infrastructure has to write their own manifests from the Dockerfiles.

Provide manifests and a chart covering the indexer Deployment, the API
Deployment with an HPA, a PVC (or Postgres from #22), and config via ConfigMap
and Secret.

**Done when:** `helm install` produces a working instance on a test cluster, and
the chart is linted in CI.

### 98. Benchmark suite and performance CI — `high`

Several issues here promise "a benchmark shows…" and there is no harness to
write one in, so those claims cannot be checked and performance can regress
invisibly.

Build a suite with a generated dataset of ≥1M events covering insert throughput,
query latency by filter, and API response times, reporting against a baseline.

**Done when:** `npm run bench` produces comparable numbers, CI tracks them, and
a significant regression is flagged on the PR.

### 99. Terraform module for a cloud deploy — `high`

Going from laptop to a hosted instance means hand-building everything.

Provide a module for at least one provider covering compute, persistent storage,
networking and secrets, with the mainnet RPC URL as a required input.

**Done when:** `terraform apply` yields a reachable instance, and `destroy`
leaves nothing behind.

### 100. Documentation site — `medium`

Docs are four markdown files plus seven READMEs. That is genuinely fine to read
on GitHub, and it has no search, no versioning and no API reference alongside
the prose.

Publish a site from the existing markdown with the OpenAPI reference (#45)
included, built in CI to GitHub Pages.

**Done when:** the site builds from the same sources — no duplicated content —
and search finds content in the module READMEs.

---

## Round two

A second hundred, filed as issues #126–#225 once the first round was mostly
merged. Same rules: each one names the code it is about, what to change, and how
you know it worked, and the numbers here are the GitHub issue numbers.

Good first issues in this round: [#130](https://github.com/soroban-forge-labs/soroban-lens/issues/130), [#132](https://github.com/soroban-forge-labs/soroban-lens/issues/132), [#137](https://github.com/soroban-forge-labs/soroban-lens/issues/137), [#145](https://github.com/soroban-forge-labs/soroban-lens/issues/145), [#150](https://github.com/soroban-forge-labs/soroban-lens/issues/150), [#158](https://github.com/soroban-forge-labs/soroban-lens/issues/158), [#160](https://github.com/soroban-forge-labs/soroban-lens/issues/160), [#166](https://github.com/soroban-forge-labs/soroban-lens/issues/166), [#167](https://github.com/soroban-forge-labs/soroban-lens/issues/167), [#171](https://github.com/soroban-forge-labs/soroban-lens/issues/171), [#172](https://github.com/soroban-forge-labs/soroban-lens/issues/172), [#188](https://github.com/soroban-forge-labs/soroban-lens/issues/188), [#189](https://github.com/soroban-forge-labs/soroban-lens/issues/189), [#194](https://github.com/soroban-forge-labs/soroban-lens/issues/194), [#200](https://github.com/soroban-forge-labs/soroban-lens/issues/200), [#202](https://github.com/soroban-forge-labs/soroban-lens/issues/202), [#205](https://github.com/soroban-forge-labs/soroban-lens/issues/205), [#206](https://github.com/soroban-forge-labs/soroban-lens/issues/206), [#210](https://github.com/soroban-forge-labs/soroban-lens/issues/210), [#213](https://github.com/soroban-forge-labs/soroban-lens/issues/213), [#217](https://github.com/soroban-forge-labs/soroban-lens/issues/217).

| Module | trivial | medium | high |
|---|---|---|---|
| Module 1 — Ingestion & RPC Client (`packages/ingest`) | 9 | 10 | 1 |
| Module 2 — Decoding & Storage (`packages/store`) | 8 | 9 | 3 |
| Module 3 — Query API (`packages/api`) | 11 | 9 | 0 |
| Module 4 — Web UI (`apps/web`) | 12 | 7 | 1 |
| Module 5 — Deployment, Docs & DX | 8 | 12 | 0 |
| **Total (100)** | **48** | **47** | **5** |

---

### Module 1 — Ingestion & RPC Client (`packages/ingest`) · Person A

#### 126. Stop retrying errors that can never succeed — `medium`

`withRetry` (`packages/ingest/src/retry.ts`) retries every rejection the same way. A JSON-RPC `-32600` "invalid request", a `400`, or a `401` from a bad provider key is retried five times with backoff before anything else sees it. The worst case is the retention-gap recovery in `EventPoller.stream()`: it can only run after the out-of-range cursor error has been retried to exhaustion, so a restart after downtime stalls for up to the full backoff budget first.

Classify errors before retrying: transport failures, `429` and `5xx` retry; JSON-RPC request errors and other `4xx` fail immediately. Keep the classifier in one exported function so the metrics error kinds and the retry decision cannot disagree.

**Done when:** a `-32600` rejects on the first attempt, a `503` still retries, and the poller test for the retention-gap restart no longer waits through backoff.

#### 127. Cursor key ignores topic filters and event type — `medium`

`defaultCursorKey(rpcUrl, contractIds)` in `poller.ts` hashes only the RPC host and the contract ids. Run the indexer with `--topic` once, then without it, and the second run resumes the first run's cursor: it silently skips everything the filtered run never fetched. The same happens when switching `--type contract` to `--type system`.

Include the event type and the topic filters in the key. Existing keys must keep working: if the filters are the defaults, produce exactly today's key, so nobody's indexer re-reads seven days of history after upgrading.

**Done when:** changing `--topic` or `--type` starts a new stream, and an unfiltered default config still resolves to the same key as before (with a test pinning it).

#### 128. Human-readable `--topic` values — `medium`

`--topic` only accepts a base64 XDR `ScVal` or `*`. Nobody types base64 by hand; in practice people run a one-off script to encode `transfer` as a symbol first.

Accept typed shorthands alongside base64: `sym:transfer`, `str:hello`, `addr:G…`/`addr:C…`, `u32:5`, `i128:-10`, `bool:true`. Encode with `nativeToScVal` / `xdr.ScVal` from the SDK. A bare value with no prefix stays base64 so existing scripts do not change meaning.

**Done when:** `--topic sym:transfer` filters SAC transfers on testnet, an unknown prefix is a usage error naming the accepted ones, and the help text shows an example.

#### 129. More than one topic filter per stream — `medium`

`parseTopicFlags` in `packages/ingest/src/bin.ts` turns every `--topic` into one positional prefix: `[flags]`. The RPC accepts up to five topic filters per event filter, ORed together, so "transfers or mints" needs two indexers today.

Add a way to express several filters, for example `--topics 'sym:transfer,*' --topics 'sym:mint,*'`, keeping repeated `--topic` as the single-filter form. Enforce the RPC limits (five filters, four segments each) with messages that say which limit was hit.

**Done when:** one stream receives both transfer and mint events from the testnet XLM contract, and six filters is a clear usage error.

#### 130. Validate numeric flags in `soroban-lens-ingest` — `trivial`

`--start-ledger`, `--end-ledger`, `--page-size`, `--poll-interval` and `--max-events` go through a bare `Number()`. `--page-size abc` becomes `NaN`, and `Math.min(NaN, 10000)` is `NaN`, which is then sent to the RPC as the page limit. The retry flags already use the `numeric()` helper; these five do not.

Reject non-integers and out-of-range values (`--page-size` 1–10000, ledgers ≥ 1, intervals ≥ 0) before anything reaches the network, exiting with code 2 like the other usage errors.

**Done when:** each flag has a test for a non-numeric value and an out-of-range value, and both exit 2 with a message naming the flag.

#### 131. Clean shutdown on Ctrl-C for `soroban-lens-ingest` — `trivial`

`EventPoller` takes an `AbortSignal` for exactly this, but `packages/ingest/src/bin.ts` never creates one. Ctrl-C or `SIGTERM` kills the process wherever it is, the metrics server is never closed, and nothing is logged.

Create an `AbortController`, abort it on `SIGINT`/`SIGTERM`, let the stream finish the batch it is on, then close the metrics server and exit 0. A second signal should exit immediately.

**Done when:** a test sends `SIGTERM` to the child process and sees exit code 0, a final log line, and no partial NDJSON line on stdout.

#### 132. Check the StrKey checksum on contract ids — `trivial`

`CONTRACT_ID_PATTERN` in `contract-id.ts` only checks the shape: `C` plus 55 base32 characters. A typo that keeps the length and alphabet passes validation and is sent to the RPC, which is the confusing failure that file exists to prevent.

Use `StrKey.isValidContract` from `@stellar/stellar-sdk`, which also verifies the CRC16 checksum. Keep the existing hint text, and add one sentence for the "right shape, wrong checksum" case, which almost always means a mistyped character.

**Done when:** a valid id with one character changed is rejected before any network call, and `lens doctor` reports it the same way.

#### 133. Liveness and readiness endpoints on the metrics server — `medium`

The metrics server answers `/metrics` and nothing else. The compose healthcheck for the indexer works around this by reading a heartbeat file in `/tmp`, which has its own problems (see the healthcheck issues in Module 5).

Add `/healthz` (process is up) and `/readyz` (a page has been fetched successfully within the last few poll intervals, and the last RPC call did not exhaust its retries). Both return a small JSON body. Readiness must not depend on events arriving: a quiet contract at the tip is healthy.

**Done when:** `/readyz` turns 503 when the RPC is unreachable and back to 200 when it returns, and the docs show a compose healthcheck that uses it.

#### 134. Measure lag from ledger close times, not a 5 s guess — `trivial`

`lagSeconds` is `lagLedgers × APPROX_LEDGER_SECONDS`. Every event already carries `ledgerClosedAt`, so the real "how far behind" is available for free: the gap between the last event's close time and now (or the RPC's latest ledger close time).

Report the measured value alongside the estimate, keeping the estimate for empty pages where no close time is known. Update the CLI log line and the metrics docs.

**Done when:** on a backfill the reported lag matches the age of the last event to within a second, and an empty page still reports the estimate.

#### 135. Per-contract event counter on `/metrics` — `medium`

`lens_events_ingested_total` has no labels, so with several contracts configured you cannot tell which one went quiet. That is the first thing anyone asks when an alert fires.

Add a `contract` label for configured contracts. When watching every contract, the label set is unbounded, so cap it (for example the first 50 contracts seen, the rest under `contract="other"`) and document the cap.

**Done when:** a two-contract run shows separate series, and an all-contracts run never produces more series than the cap.

#### 136. Split HTTP errors into client and server errors in metrics — `trivial`

`IngestMetrics.rpcError` reports every HTTP failure that is not a 429 as `kind="http"`. A `401` from a mistyped provider key and a `503` from a provider outage land in the same series, and they need very different responses.

Report `kind="http_4xx"` and `kind="http_5xx"` (keeping `rate_limit` for 429). Update `docs/metrics.md` and the example alert rules.

**Done when:** a test feeds a 401 and a 503 and sees two different series, and the alert example distinguishes them.

#### 137. Clean up orphaned cursor temp files — `trivial`

`FileCursorStore.save` writes `<key>.cursor.json.<pid>.tmp` and then renames it. If the process dies between the two, the temp file stays forever, and after many restarts the data directory fills with them. `clear()` also writes `{}` into the file instead of removing it.

On construction, delete stale `*.tmp` files for this store. Make `clear()` unlink the file (ignoring ENOENT), and check that `load` still treats a missing file as no cursor.

**Done when:** a test leaves a temp file behind, constructs a new store, and finds it gone, and `clear()` leaves no file.

#### 138. Detect an RPC node that has stopped advancing — `medium`

If a node falls out of sync, `getEvents` keeps answering with the same `latestLedger`. The poller sees short pages, decides it is caught up, sleeps and asks again, forever. Nothing in the logs or metrics says the network moved on and the node did not.

Track `latestLedger` across polls. If it has not moved for a configurable time (default 60 s, about 12 ledgers), log a warning once and set a `lens_rpc_stalled` gauge. Clear both when it moves again. This does not need failover (#12) to be useful.

**Done when:** a fake client returning a fixed `latestLedger` triggers the warning after the threshold, and the gauge clears on the next advance.

#### 139. Check the network passphrase on startup — `trivial`

`--network mainnet --rpc-url <a testnet node>` is accepted without complaint, and every stored event is labelled mainnet. The RPC's `getNetwork` method returns the passphrase, and `NETWORKS` already holds the expected one.

Call `getNetwork` once before the first poll and fail with a clear message if the passphrase does not match the selected network. Add the same check to `lens doctor`.

**Done when:** a testnet URL with `--network mainnet` fails before indexing anything, and the matching case passes.

#### 140. Back off polling on quiet contracts — `medium`

At the tip, the poller sleeps `pollIntervalMs` (2 s) and asks again, whether the contract emits every ledger or once a week. A quiet contract costs about 43 000 requests a day, which matters on a metered provider.

After consecutive empty polls, grow the idle interval up to a cap (for example 30 s), and reset to the base interval as soon as an event arrives. Make the cap configurable, and keep the default behaviour unchanged when it is set equal to the base.

**Done when:** a fake client with no events shows the interval growing to the cap, one event resets it, and the setting is documented.

#### 141. Load contract ids from a file — `medium`

Contracts come from repeated `-c` flags or the comma-separated `LENS_CONTRACT_IDS`. Past a handful of ids that is unreadable, and there is nowhere to write down why a contract is being watched.

Add `--contracts-file <path>`: one id per line, `#` comments allowed, blank lines ignored. Every id is validated with the same rules as `-c`, and errors report the line number.

**Done when:** a file with comments and 20 ids indexes the same as passing them on the command line, and a bad id reports its line.

#### 142. Add a contract without replaying every other one — `high`

The cursor key is a hash of the whole contract set. Add one contract to a running indexer and the key changes, so the new stream starts again from the oldest retained ledger for every contract, re-reading up to seven days that are already stored.

Give contracts their own progress: existing contracts continue from their cursor, and a newly added contract is backfilled from its start ledger by a separate stream until it catches up, then merged into the main one. Removing a contract should not reset the others either.

**Done when:** adding a contract to a running config re-reads no events for the others (verified by counting RPC pages in a test), and the new contract ends up fully indexed.

#### 143. Record and replay RPC traffic for tests — `medium`

Poller tests use hand-written fake clients. They are fast, but they only cover the responses someone thought to write, and real RPC quirks (cursor formats, error bodies, close-time strings) have to be guessed.

Add a small recorder that wraps the real client and writes `getHealth` / `getEvents` request and response pairs to a fixture file, plus a fake client that replays such a file. Commit one recording from testnet and use it in at least one poller test. This is the cheap complement to the quickstart integration test (#20).

**Done when:** a poller test runs end to end from a committed recording with no network, and the README explains how to refresh it.

#### 144. Decide what `--type diagnostic` means — `trivial`

`EventType` and the `--type` flag accept `diagnostic`, but `RawEvent.type` in `packages/ingest/src/types.ts` documents that the RPC only emits `contract` and `system`, and the store's `type` column and types only allow those two. Either the flag can never return anything, or it returns events the rest of the pipeline is not typed for.

Find out which, against a real node. Then either remove `diagnostic` from the flag and the docs, or widen the types end to end and add a test that stores one.

**Done when:** the flag, the types and the store agree, and the issue records what the RPC actually returned.

#### 145. Fill in the retention close times or drop them — `trivial`

`LensRpcClient.retention()` returns `latestLedgerCloseTime: ''` and `oldestLedgerCloseTime: ''` every time. They are declared in `RetentionState`, so they look like data, but nothing ever sets them.

The `getEvents` response includes the latest and oldest ledger close times. Fill the fields from a real source, or remove them from `RetentionState` if nothing needs them. Either way, no field should be a permanent empty string.

**Done when:** the fields carry real timestamps or no longer exist, and a test covers whichever you chose.

---

### Module 2 — Decoding & Storage (`packages/store`) · Person B

#### 146. Topic filters cannot tell a symbol from a string — `medium`

`topicKey` in `decode.ts` stores only the rendered value in `topic0`…`topic3`. The symbol `transfer` and the string `"transfer"` are both `transfer`, and the u32 `5`, the i128 `5` and the string `"5"` are all `5`. A topic filter matches all of them.

Keep the type with the key, for example a parallel `topicN_type` column or a `symbol:transfer` encoding, and let a query ask for a type. Plain values must keep matching as they do today, so existing API callers see no change.

**Done when:** a query for symbol `transfer` excludes a string `transfer`, an untyped query still returns both, and the migration backfills existing rows.

#### 147. Filter an address by where it appears — `medium`

`event_addresses` already records the position of every address (`topic0`…`topicN` or `value`), but `EventQuery.address` matches it anywhere. For a SAC transfer, "transfers from G…" and "transfers to G…" are the questions people ask, and today both get the union.

Add an optional `addressPosition` (`topic1`, `value`, …) that narrows the existing subquery. The index on `(address, event_id)` may need `position` added; check with `EXPLAIN QUERY PLAN`.

**Done when:** on the fixture, filtering an address at `topic1` returns only events where it is the sender, and the query plan still uses the index.

#### 148. Find payments to muxed accounts — `medium`

Under CAP-67, a SAC transfer to a muxed account emits the base `G…` address as a topic and carries the muxed id in the event data (`to_muxed_id`). The address index stores the `G…` address only, so there is no way to ask for events for one `M…` address, and searching the `M…` string finds nothing.

When the data carries a muxed id, store it next to the address. Accept an `M…` address in `EventQuery.address` and match it as base account plus muxed id.

**Done when:** a fixture transfer to a muxed account is found by its `M…` address, and searching the base `G…` address still finds it too.

#### 149. Map keys that are not scalars lose information — `medium`

Decoded values come from `scValToNative`, which builds a map as a plain JS object. Keys go through property-key coercion: a `bytes` key becomes a comma-joined byte list, a `vec` key its joined elements, a `map` key `[object Object]`. Two different keys can become the same string, and one value silently overwrites the other.

Detect maps whose keys are not symbols, strings or numbers, and render them as an ordered array of `{ key, value }` pairs, with each key decoded the normal way. Scalar-keyed maps keep their current shape, since that is what every caller expects.

**Done when:** a test map with two distinct `vec` keys decodes to two entries, and scalar-keyed maps are byte-for-byte unchanged.

#### 150. Filter by event type — `trivial`

Every row stores `type` (`contract` or `system`), but `EventQuery` has no way to filter on it. Anyone indexing system events alongside contract events gets both in every query.

Add `type?: 'contract' | 'system'` to `EventQuery`, add it to `buildWhere`, and add a case to the conformance suite in `testing.ts` so every backend has to support it.

**Done when:** the conformance suite covers both values and the SQLite store passes it.

#### 151. Query several contracts at once — `trivial`

`EventQuery.contractId` takes one id. A dashboard for a protocol with a token, a pool and a router has to make three requests and merge three keyset cursors itself.

Add `contractIds?: string[]` (capped, for example at 20) using `contract_id IN (…)`. Keep `contractId` working, and reject a query that sets both.

**Done when:** a two-contract query returns both contracts' events in one correctly ordered page, and pagination across it works.

#### 152. Keep contract summaries up to date instead of recomputing them — `medium`

`listContracts` runs `COUNT(*)`, `MIN(ledger)`, `MAX(ledger)` and a `GROUP BY` over the whole events table on every call. The UI calls it through `/contracts`, and in all-contracts mode that table is the biggest one in the database.

Keep a `contract_summaries` table updated in the same transaction as each insert, plus prune and import. Add a `lens verify` check that compares it against a fresh `GROUP BY`.

**Done when:** `listContracts` reads only the summary table, a bench shows the difference on a large fixture, and `lens verify` catches a summary that has drifted.

#### 153. Topic counts for positions other than the first — `trivial`

`listTopics(contractId)` counts only `topic0`. For a SAC, `topic0` is just `transfer`/`mint`/`burn`, and the useful question is which addresses appear in `topic1` and `topic2`.

Add an optional `position` (0–3) parameter, defaulting to 0 so current callers are unchanged. Use the existing topic columns, and add an index only if `EXPLAIN QUERY PLAN` shows a full scan.

**Done when:** `listTopics(id, { position: 1 })` returns the most frequent senders on the fixture, and the default output is unchanged.

#### 154. Prune one contract, or by age — `medium`

`pruneBefore(ledger)` deletes below one ledger for every contract. You cannot drop a noisy contract you no longer care about, or keep "the last 30 days" without working out a ledger number yourself.

Add a contract-scoped prune and an age-based prune (`olderThanDays`, using `closed_at_unix`). The address and FTS side tables have to be cleaned in the same transaction.

**Done when:** pruning one contract leaves every other contract's rows untouched, and `lens verify` passes afterwards.

#### 155. Export a subset of the database — `trivial`

`exportSnapshot` writes every event. Sharing one contract's history for a bug report, or moving one contract to another instance, means exporting everything and filtering the NDJSON by hand.

Accept an `EventQuery`-style filter (contract, ledger range, time range) in `exportSnapshot` and `lens export`. Import needs no change.

**Done when:** `lens export out.ndjson -c C…` writes only that contract, and re-importing it into an empty database round-trips.

#### 156. Filter on typed field values — `high`

Typed decoding (#33) works out field names and types when an event is read, so nothing can filter on them: "transfers over 1 000 XLM" is not a query you can run. The amounts are i128 values stored as decimal strings, and comparing those as text gives the wrong answer.

Store typed fields in a side table (event id, field name, numeric value where it fits, text value otherwise), filled at insert and again when a contract's spec arrives later. Support equality on any field and range comparisons on numeric fields. Keep it optional and measure the cost of the insert path.

**Done when:** a range query on `amount` returns the right fixture events, a spec arriving after the events backfills them, and the insert benchmark is in the PR.

#### 157. Keep a contract's spec for each Wasm version — `high`

`contract_specs` has one row per contract. When a contract is upgraded to new Wasm, the new spec replaces the old one, and every older event is then decoded with a spec that may not match it. The result is wrong field names, or a typed view that silently disappears.

Store specs per Wasm hash, and record the ledger at which each contract switched hash. Decode each event with the spec that was live at its ledger, and show which hash was used in the typed view.

**Done when:** a test with two Wasm versions decodes events on each side of the upgrade with the right spec, and existing rows migrate without a re-fetch.

#### 158. Open the store read-only — `trivial`

`SqliteEventStore` always opens the file read-write and runs `PRAGMA journal_mode = WAL` in the constructor. The API only ever reads, but a bug in it could still write, and it cannot be pointed at a read-only snapshot.

Add a `readOnly` option that opens with `node:sqlite`'s read-only flag, skips migrations and the WAL pragma, and makes every write method throw a clear error. The API change itself is a separate Module 3 issue.

**Done when:** a read-only store serves queries from a file another process is writing, and `insertEvents` on it throws.

#### 159. Keep slow queries from blocking the API — `high`

`node:sqlite` is synchronous. Every store method is `async` in name only, so a slow full-text search or a `COUNT(*)` over millions of rows blocks the API's event loop: health checks, other requests and response compression all wait behind it.

Move reads to a small `worker_threads` pool, each worker with its own read-only connection, behind the same `EventStore` interface. Measure p99 latency for concurrent cheap requests while an expensive one is running, before and after.

**Done when:** a slow search no longer delays a concurrent `/health`, the conformance suite passes against the pooled store, and the numbers are in the PR.

#### 160. Count decode failures in `getStats` — `trivial`

Rows that fail to decode are kept with `decode_error` set, and `lens redecode` can fix them later. But `getStats` and `lens stats` do not say how many there are, so nobody knows when it is worth running.

Add `decodeErrorCount` to `StoreStats`, show it in `lens stats` with a hint to run `lens redecode` when it is above zero, and return it from `/stats`.

**Done when:** seeding a fixture with one bad row shows a count of 1, and the hint appears.

#### 161. Refuse a database written by a newer version — `trivial`

`#migrateSync` applies any migration it knows about that is missing, and never looks at versions it does not know. Open a database created by a newer soroban-lens (version 7) with an older build (which knows 6), and it carries on against a schema it does not understand.

If `schema_migrations` contains a version above the highest known migration, fail with a message naming both versions and telling the user to upgrade.

**Done when:** a test inserts version 999 into `schema_migrations` and gets that error from `migrate()`.

#### 162. Property-based tests for the decoder — `medium`

`decode.test.js` checks hand-picked values. The decoder's promise is broader: it never throws, and its output always survives a JSON round-trip, whatever a contract emits. That is exactly what generated inputs test well.

Add a generator for random, nested `ScVal`s covering every arm, and assert that `decodeEvent` never throws, `JSON.parse(JSON.stringify(x))` deep-equals `x`, and `extractAddresses` finds every address that was put in. Use a fixed seed in CI, and print the seed on failure.

**Done when:** the property test runs on every CI build in under 10 seconds, and any failure can be reproduced from its printed seed.

#### 163. Retention by database size — `medium`

Disk is the limit operators actually hit, but prune works only by ledger. Keeping "about 20 GB" today means watching the volume and running prune by hand.

Add an optional size target. When `sizeBytes + walSizeBytes` exceeds it, prune the oldest ledgers in chunks until it fits, then checkpoint. Run it on an interval from the indexer, and log what was removed.

**Done when:** a test with a tiny target prunes the oldest rows first and stops once under the target, and the setting is documented.

#### 164. Filter topics past the fourth position — `medium`

Only `topic0`…`topic3` are columns, so `INDEXED_TOPIC_DEPTH` is 4 and deeper filters are rejected. The RPC can only filter four segments, but events can carry more (`fixtures/README.md` documents this), and the store has every one of them.

Index topic positions 4 and up in a side table, the same pattern as `event_addresses`, and allow filters on them. Positions 0–3 keep using the existing columns.

**Done when:** a filter on `topic5` returns the right fixture event, and queries on 0–3 have the same plan as before.

#### 165. Query events by when they were indexed — `trivial`

`indexed_at` is indexed (#36), but `EventQuery` cannot filter on it. Anything that syncs out of the database incrementally (a webhook sender, an export job) wants "everything indexed since my last run", which is not the same as ledger order during a backfill.

Add `indexedAfter` (ISO timestamp, exclusive) to `EventQuery` and the conformance suite.

**Done when:** a test inserts two batches and gets only the second with `indexedAfter` set to the first batch's time.

---

### Module 3 — Query API (`packages/api`) · Person C

#### 166. Validate `limit` on `/contracts` and `/contracts/{id}/topics` — `trivial`

Both handlers in `packages/api/src/server.ts` do `Number(query.get('limit'))` with no check. `limit=abc` passes `NaN` to the store, and `limit=-1` passes a negative number. `/events` already rejects both through `parseEventQuery`.

Use the same integer parsing and range check, return `400` with the parameter name, and add tests.

**Done when:** `limit=abc`, `limit=0` and `limit=100000` all return `400` on both routes.

#### 167. Validate the API's startup flags — `trivial`

`packages/api/src/bin.ts` does `Number(values.port ?? …)`. `--port abc` gives `NaN`, and Node then listens on a random port while the log line still prints `NaN`.

Reject a port that is not an integer from 1 to 65535 with exit code 2, the same way `parseMetricsPort` does for the indexer.

**Done when:** `--port abc` and `--port 70000` exit 2 with a clear message.

#### 168. `GET /transactions/{txHash}` — `trivial`

The store can filter by `txHash`, but there is no route that answers "what did this transaction emit?" in one call, ordered the way it happened. That is the most common question when debugging a contract call.

Add the route: every event for the hash, ordered by operation index and then event id, plus a small summary (ledger, close time, contracts touched, whether the call succeeded). Return `404` if nothing is stored for that hash, and update `openapi.json`.

**Done when:** the route returns the fixture transaction's events in order, an unknown hash returns 404, and the OpenAPI lint passes.

#### 169. Address summary endpoint — `medium`

`/events?address=` lists events, but the first question about an address is a summary: which contracts it has touched, how often, and when it was first and last seen.

Add `GET /addresses/{address}` returning per-contract counts and first/last ledger from `event_addresses`. Validate the address shape, and update `openapi.json`.

**Done when:** the fixture's busiest address returns correct counts per contract, and an unseen address returns empty results rather than an error.

#### 170. Paginate `/contracts` — `medium`

`/contracts` takes `limit` (default 100) and nothing else. In all-contracts mode there can be thousands, and past the first page they are unreachable.

Add keyset pagination ordered by last ledger, with `nextCursor` shaped like `/events`. Keep the current response fields so existing callers do not break.

**Done when:** walking every page returns each contract exactly once, including while new events arrive.

#### 171. Allow more than one CORS origin — `trivial`

`LENS_CORS_ORIGIN` is one string written to `Access-Control-Allow-Origin`. A staging UI and a production UI pointed at the same API cannot both work, except with `*`.

Accept a comma-separated list. Echo the request's `Origin` when it is on the list, omit the header when it is not, and add `Vary: Origin`. `*` keeps working as it does now.

**Done when:** tests cover an allowed origin, a disallowed one, and `*`.

#### 172. Let browsers read `X-Request-Id` — `trivial`

The API sets `X-Request-Id` on every response so a bug report can be matched to a log line. Cross-origin, the browser hides it, because there is no `Access-Control-Expose-Headers`, so the UI cannot show it in an error message.

Expose `X-Request-Id` (and `Retry-After`, which the 503 path sets).

**Done when:** a test checks the header, and the UI issue that shows the request id in errors can use it.

#### 173. Cache headers for data that does not change — `trivial`

Every response is sent with `Cache-Control: no-store`. An event fetched by id never changes (short of a redecode), and `/openapi.json` changes only with a deploy, yet every reload fetches both again.

Send a modest `max-age` for `/events/{id}` and `/openapi.json`, and keep `no-store` on lists, `/status` and `/health`. This complements ETags (#47); it does not replace them.

**Done when:** tests pin the header for each route class, and the README says which routes are cacheable.

#### 174. Compress without blocking the event loop — `medium`

`send()` uses `gzipSync` / `deflateSync`. A 1 000-row page with raw XDR is several hundred KB, and compressing it synchronously stalls every other request. Brotli, which most browsers prefer, is not offered at all.

Switch to the async zlib functions or streams, add `br` when the client accepts it, and keep the size threshold so small bodies are not compressed.

**Done when:** a test sees `Content-Encoding: br` for a client that asks for it, and a large response no longer delays a concurrent `/health` measurably.

#### 175. Serve the API from a read-only connection — `trivial`

Once the store has a `readOnly` option (Module 2), the API should use it. The API never writes, and a read-only connection makes that a guarantee rather than a convention.

Open the store read-only in `packages/api/src/bin.ts`. `/health` and the schema-currency check must still work, and if the database has not been migrated yet the API should report it clearly, since it can no longer migrate.

**Done when:** the API serves the fixture from a read-only connection, and an unmigrated database gives a clear 503.

#### 176. Security headers — `trivial`

Responses carry no `X-Content-Type-Options`, `Referrer-Policy`, or `Content-Security-Policy`. `/docs` serves an HTML page that loads Redoc, which is where a CSP matters most.

Add `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` everywhere, and a CSP on `/docs` that allows exactly what the page loads.

**Done when:** tests pin the headers, and `/docs` still renders with the CSP in place.

#### 177. Configure server timeouts — `trivial`

The API runs with Node's default `headersTimeout`, `requestTimeout` and `keepAliveTimeout`. Behind a load balancer the keep-alive default is a known source of intermittent 502s, and nothing bounds a client that sends headers slowly.

Set explicit values, make them configurable through env, and document what to set when running behind a proxy.

**Done when:** the values are set in `bin.ts`, a test checks them on the created server, and the README has a short section on them.

#### 178. Filter `/events` by type and by several contracts — `trivial`

Once the store supports filtering by event type and by several contracts (Module 2), expose both as `type=` and `contractIds=` (comma-separated), with the same validation style as the other parameters.

Reject `contractId` and `contractIds` together, and cap the list at the store's limit.

**Done when:** both parameters are in `openapi.json` and tested, including the cap.

#### 179. Contract labels from a file — `trivial`

Contracts are 56-character ids, and every screen shows them raw. Operators know which one is "USDC SAC" or "the pool", but cannot tell soroban-lens.

Load an optional JSON file (`LENS_CONTRACT_LABELS`) mapping contract id to label, and include `label` on `/contracts` and `/contracts/{id}/stats`. A file keeps the API read-only, and invalid ids in it fail at startup.

**Done when:** labels appear on both routes, a missing file means no labels rather than an error, and the format is documented.

#### 180. Stream results as NDJSON — `medium`

Pulling a large range through `/events` means paging 1 000 rows at a time. The CSV issue (#41) is about spreadsheets; tooling wants a stream it can pipe into `jq`.

When the request has `Accept: application/x-ndjson`, stream every matching event one line at a time with keyset iteration underneath, keeping memory flat. Add a configurable row cap, and end with a trailer line saying whether the cap was hit.

**Done when:** a 100 000-row stream keeps memory flat, the cap and trailer are tested, and `curl … | jq` works in the README.

#### 181. Report each stream's lag on `/status` — `medium`

`/status` returns each stream's cursor and last ledger, but not how far behind the network it is, because the API never talks to the RPC. The UI cannot say "2 minutes behind" without that.

Have the indexer save the RPC's `latestLedger` and the time it was seen with each stream state, and return `lagLedgers` and the age of that sample from `/status`. Keep the API RPC-free.

**Done when:** `/status` shows lag for a running indexer, and a stopped indexer shows a growing sample age instead of a stale "0 behind".

#### 182. Check every response against `openapi.json` in tests — `medium`

The tests check that `/openapi.json` describes every route, but not that responses match the schemas. A field added to a handler and not to the spec passes CI.

In the API tests, validate each response body against its OpenAPI schema with a small validator, covering the success and error shape of every route. Fail on extra properties wherever the schema says `additionalProperties: false`.

**Done when:** removing a field from a schema makes a test fail, and every route has at least one validated response.

#### 183. Errors as `application/problem+json` — `medium`

Errors use a custom `{ error: { … } }` body. RFC 9457 problem details is the format most HTTP clients and gateways understand.

Serve problem details (`type`, `title`, `status`, `detail`, plus the existing parameter name and request id as extension members) when the client accepts `application/problem+json`, and keep today's body otherwise. Update `openapi.json` for both.

**Done when:** both formats are tested on a 400 and a 404, and the default response is unchanged.

#### 184. Request metrics for the API — `medium`

The indexer has `/metrics`; the API has none. Slow routes and error rates are only visible by reading logs.

Expose request counts and a duration histogram labelled by route pattern (not raw path, to keep the label set bounded), method and status class, in the same hand-written Prometheus format as `packages/ingest/src/metrics.ts`. Serve it on a separate port that is off by default.

**Done when:** after a few requests, `/metrics` shows bounded series, and an unknown path does not create a new one.

#### 185. Version the API under `/v1` — `medium`

Every route lives at the root, with no version anywhere. The first breaking change, such as a renamed field or a changed default, will break every client at once with no transition period.

Serve every route under `/v1` as well as at the root. Mark the root paths as deprecated in `openapi.json` and send a `Deprecation` header on them, and write down in the API README what counts as a breaking change.

**Done when:** every route answers the same under `/v1`, root paths carry the header, and the OpenAPI lint passes.

---

### Module 4 — Web UI (`apps/web`) · Person D

#### 186. Live refresh throws away rows loaded with "Load more" — `medium`

With live updates on, `usePolling` calls `loadFirstPage` every 5 s, and `loadFirstPage` replaces `events` with the first page. Scroll down, click "Load more", read for five seconds, and the list snaps back to 50 rows.

On a live tick, merge new rows in at the top by id and keep everything already loaded. Keep `nextCursor` pointing past the oldest loaded row rather than resetting it.

**Done when:** a test loads two pages, fires a poll, and still has every row from both pages plus any new ones.

#### 187. Show new events without moving the page — `medium`

When a live refresh brings new rows, they are inserted at the top and everything shifts down under the reader's cursor. If someone is reading row 30, it jumps away.

If the table is scrolled away from the top, hold new rows back and show a "N new events" pill, and insert them when it is clicked or when the user scrolls back to the top. At the top, keep inserting immediately.

**Done when:** scrolled down, a poll shows the pill and nothing moves; clicking it inserts the rows and scrolls to the top.

#### 188. Address filter in the UI — `trivial`

The API supports `address=` on `/events` (#23), but the UI only offers contract and topic. Finding everything an account did needs a hand-written API call.

Add an address field next to the topic field, validating `G…`/`C…` shape before sending, and persist it with the other filters.

**Done when:** entering a fixture address lists only its events, and an invalid address shows the same kind of warning as an invalid contract id.

#### 189. Search box — `trivial`

`/events?search=` does full-text substring search (#32), and there is no way to use it from the UI.

Add a debounced search field. Explain the three-character minimum inline instead of sending a query that can only come back empty.

**Done when:** searching a fixture value finds the event, and a two-character query shows the hint without making a request.

#### 190. Time range filter — `trivial`

#68 adds a ledger range to the UI, but people think in time: "what happened in the last hour". The API already takes `fromTime` / `toTime`.

Add presets (last 15 minutes, hour, day) and a custom range, converted to epoch seconds. Show the active range in the result summary.

**Done when:** each preset sends the right parameters, and clearing the range removes them.

#### 191. Transaction view — `medium`

`txHash` is displayed but leads nowhere. When debugging, the useful view is every event the transaction emitted, in order. The API issue for `GET /transactions/{txHash}` provides it.

Make the hash clickable and open a panel listing the transaction's events, with operation indexes, success state, and each event's existing expanded view. The panel should have its own URL once deep links (#63) exist.

**Done when:** clicking a fixture hash shows all its events in order, and closing the panel returns to the same scroll position.

#### 192. Show a contract's declared events — `medium`

`GET /contracts/{id}/spec` returns the events a contract declares (#33), but the UI only uses it indirectly, through typed rows. Seeing the event names and their fields up front is often what someone opening a contract wants first.

When a contract is selected, show a collapsible panel of its declared events and their fields with types, and say where the spec came from (Wasm or Stellar Asset). Clicking an event name filters to it.

**Done when:** the XLM SAC shows its built-in events, a contract without a spec shows an honest "no spec" state, and clicking an event name filters the table.

#### 193. Format token amounts with their decimals — `medium`

SAC amounts are i128 values in stroops, so a 1 XLM transfer shows as `10000000`. Typed decoding knows a field is an `amount`, but the UI shows the raw integer.

For Stellar Asset Contracts (7 decimals), show the formatted amount with the raw value on hover and on copy. Do the arithmetic as a decimal string, never through `Number`, because i128 exceeds safe integers. Leave other contracts' integers alone unless their decimals are known.

**Done when:** fixture SAC transfers show human amounts, a value above 2^53 formats exactly, and non-SAC values are unchanged.

#### 194. Check saved filters before using them — `trivial`

`usePersistentState` returns whatever `JSON.parse` gives back from localStorage, cast to `FilterState`. Once a new filter field is added (address, search, time range), returning users have saved state without it, and the input gets `undefined`, which React reports as switching from uncontrolled to controlled.

Merge stored state over the defaults, drop keys that are not in the defaults, and reset if the stored value is not an object.

**Done when:** a test seeds old-shaped and garbage values, and both render with defaults filled in.

#### 195. Stop fetching `/health` on every live tick — `trivial`

The health effect in `App.tsx` depends on `lastUpdated`, which changes on every successful poll, so live mode fetches `/health` every 5 s as well as `/events`.

Poll health on its own slower interval (for example 30 s), and refresh it right away when a poll fails.

**Done when:** a minute of live mode makes at most a couple of `/health` requests, and a failure still updates the status bar right away.

#### 196. Show "Load more" errors next to the button — `trivial`

A failed `loadMore` sets the same `error` state as the main query, so the page-level banner says the whole view failed when the rows on screen are fine.

Show load-more failures inline next to the button with a retry, and leave the main banner for first-page failures.

**Done when:** a mocked load-more failure shows an inline message and retry, and the table and banner are untouched.

#### 197. Configure API endpoints at runtime — `medium`

`VITE_LENS_NETWORKS` is baked into the bundle at build time (see the `web` service in `docker-compose.yml`), so the same image cannot be pointed at a different API without rebuilding it.

Load `/config.json` at startup, with the same shape as the env variable, and fall back to the build-time value when it is missing. Have the nginx image generate that file from an env var when the container starts.

**Done when:** one built image serves two different API URLs by changing only env, and the dev server still works with no config file.

#### 198. Typed columns in CSV export — `medium`

The CSV export writes topics and value as JSON blobs. With typed decoding, when every row is the same event from one contract, those blobs could be real columns (`from`, `to`, `amount`) that open straight into a spreadsheet.

When the exported rows share one typed event name, write one column per typed field after the standard columns. Otherwise keep today's format. Escape values with the same rules as now.

**Done when:** exporting fixture SAC transfers produces `from,to,amount` columns, and a mixed export is unchanged.

#### 199. Show contract labels where ids appear — `trivial`

Once the API returns contract labels (Module 3), show them wherever a contract id is displayed: in the contract column, in the filter field once one is chosen, and in the status bar. Show the full id on hover.

**Done when:** a labelled fixture contract shows its label in all three places, and unlabelled contracts look exactly as they do now.

#### 200. Mark estimated totals — `trivial`

The store returns `totalIsEstimate: true` when the total comes from its count cache. The UI types do not include the field, and it shows "1,234 events" as if exact.

Pass the field through `types.ts` and render "about 1,234" with a tooltip explaining it when the flag is set.

**Done when:** a mocked page with the flag renders "about", and one without it renders the exact number.

#### 201. End-to-end browser tests against the fixture — `high`

#62 covers component tests. Nothing checks the real thing: the built UI, against a real API, over the seeded fixture database, in a browser.

Add a Playwright suite that seeds the fixture, starts the API, and serves the built UI. Cover filtering by contract and topic, expanding a row, load more, and the empty and error states. Run it in CI with traces uploaded on failure.

**Done when:** the suite runs in CI in under three minutes, and a deliberately broken selector fails it with a useful trace.

#### 202. Page title reflects what you are looking at — `trivial`

The tab always says the same thing. With several tabs open on different contracts, you cannot tell them apart, or see that new events arrived in a background tab.

Set the document title to the active contract (label if known, short id otherwise), and prefix a count of unseen live events while the tab is hidden.

**Done when:** switching contracts updates the title, and a background tab shows the count, which clears when the tab is focused again.

#### 203. Topic suggestions for other positions — `trivial`

The topic field's suggestions only come from `topic0`. Once the store and API can count other positions (Module 2), offer suggestions for the position being filtered, so picking a sender from `topic1` is a click instead of a copy and paste.

**Done when:** suggestions follow the selected position, and the default (first position) behaves as it does now.

#### 204. Show the request id when something fails — `trivial`

When a request fails, the banner shows only the message. Matching a user's screenshot to a log line means guessing by timestamp, even though the API tags every response with `X-Request-Id`.

Once the API exposes the header (Module 3), read it in `api.ts` and show it in error banners in small monospace text, with a copy button.

**Done when:** a failed request's banner shows the id, and it matches the API log line for that request.

#### 205. Click an address to filter by it — `trivial`

Expanded rows and typed fields show addresses inside decoded values, but they are plain text. Following a sender to see what else they did means copying the address into the URL by hand.

Render `G…` and `C…` values in decoded output as buttons that set the address filter, or the contract filter for a `C…` address in contract position. Ordinary strings that merely look similar must not become links: use the decoded type, not a regex on the text.

**Done when:** clicking a sender in a fixture transfer filters to that address, and a string value with the same text stays plain.

---

### Module 5 — Deployment, Docs & DX · Person E

#### 206. Indexer healthcheck passes before the indexer has done anything — `trivial`

The indexer healthcheck in `docker-compose.yml` exits 0 when the heartbeat file does not exist. An indexer that is stuck before its first batch (bad RPC, wrong contract, empty range) reports healthy forever.

Treat a missing heartbeat as unhealthy once `start_period` has passed. Docker already ignores failures during `start_period`, so startup is not affected.

**Done when:** an indexer pointed at an unreachable RPC turns unhealthy, and a working one stays healthy.

#### 207. Heartbeat goes stale on quiet contracts — `medium`

`runIndexer` writes the heartbeat inside `for await (const batch of poller.stream())`, but the poller only yields when a page has new events. At the tip of a contract that emits rarely, nothing is yielded, the heartbeat goes stale after 60 s, and the container is reported unhealthy while working perfectly. The file is also a fixed path in `tmpdir()`, so two indexers on one machine overwrite each other.

Write the heartbeat on every completed poll, not every yielded batch (for example through a progress callback on the poller), and key the file by stream. Better still, once the metrics server has `/readyz` (Module 1), point the healthcheck there.

**Done when:** an indexer on a contract with no events stays healthy for ten minutes, and two indexers keep separate heartbeats.

#### 208. `lens index` is missing `--topic`, `--type` and `--end-ledger` — `medium`

`soroban-lens-ingest` supports topic filters, event type and bounded ranges. `lens index`, which is what docker compose and most people run, passes none of them to `EventPoller`, so there is no way to index only transfers, or to index a fixed historical window into the database.

Add the same flags and env variables to `packages/cli/src/config.ts`, with the same validation, sharing the parsing code with the ingest binary rather than copying it. The cursor-key issue in Module 1 needs to land first, or switching filters will resume the wrong cursor.

**Done when:** `lens index --topic sym:transfer --end-ledger N` stores only transfers up to N and exits, and the help text for both binaries matches.

#### 209. Linting and formatting in CI — `medium`

There is no ESLint or Prettier configuration, so style is whatever each contributor's editor does. Review time goes on formatting, and simple mistakes such as floating promises are caught only by luck.

Add ESLint with `typescript-eslint` (including `no-floating-promises`) and Prettier, matching the current code style as closely as possible. Run them in CI. Land the bulk reformat as its own commit, and list it in `.git-blame-ignore-revs`.

**Done when:** `npm run lint` passes on main, CI fails on a lint error, and `git blame` skips the reformat commit.

#### 210. Add `.editorconfig` and `.nvmrc` — `trivial`

`package.json` requires Node `>=22.13.0` (for `node:sqlite`), but nothing tells nvm, fnm or asdf which version to use, and newcomers on Node 20 get a confusing import error. There is no `.editorconfig` either.

Add `.nvmrc` with the version CI tests on, and an `.editorconfig` matching the current style (2 spaces, LF, final newline). Mention both in CONTRIBUTING.md.

**Done when:** `nvm use` in the repo selects a working Node, and the files match what the code already does.

#### 211. Changelog and versioning — `medium`

Every package is `0.1.0` and there is no changelog, so users cannot tell what changed between two commits they deployed. #83 publishes images and releases; this is the record of what each release contains.

Adopt Changesets (or a similar tool): contributors add a short changeset with each user-facing PR, and the release workflow turns them into `CHANGELOG.md` entries and version bumps. Add a CI check that reminds PRs touching `packages/` without a changeset.

**Done when:** a PR with a changeset produces a changelog entry on release, and the CONTRIBUTING.md section explains the flow in a few lines.

#### 212. Dev container — `medium`

Setting up means the right Node version, building every workspace, then seeding, and Docker if you want compose. A dev container makes that one click in Codespaces or VS Code.

Add `.devcontainer/` with the CI Node version, run `npm ci && npm run build && npm run seed` after creation, and forward the API and web ports.

**Done when:** a fresh Codespace reaches a working UI on the fixture with no manual steps, and the README links to it.

#### 213. `lens config` prints the resolved configuration — `trivial`

Configuration comes from flags, env variables and defaults across `config.ts`. When something behaves unexpectedly, the first question is which value actually won, and there is no way to see that.

Add `lens config`, printing each setting, its value and where it came from (flag, env or default). RPC header values must be redacted, like everywhere else.

**Done when:** each source is shown correctly in a test, and header values never appear in the output.

#### 214. `lens spec refresh` for every contract — `trivial`

`lens spec fetch -c <id>` refreshes one contract. After a contract upgrade, or once the RPC that failed earlier is back, refreshing every stored spec means a shell loop.

Add `lens spec refresh [--only-missing]`, which re-fetches every contract in `contract_specs` (or only the `none` and errored ones), with a concurrency limit and a summary at the end.

**Done when:** the command refreshes the fixture contracts against a fake source in a test, and `--only-missing` skips the ones that already have a spec.

#### 215. Config file support — `medium`

Everything is configured with flags or about 20 `LENS_*` env variables. A deployment with several contracts, headers and retry settings ends up as a long, unreviewable env block.

Support an optional `lens.config.json`, with a JSON Schema, using the same keys as the env variables. The order of precedence is flag, then env, then file, then default. Resolve it in `config.ts` so every command picks it up, and have `lens config` (above) show it as a source.

**Done when:** a config file drives `lens index` in a test, env still overrides it, and the schema is published in `docs/`.

#### 216. Grafana dashboard for the indexer — `medium`

`docs/` has a Prometheus scrape config and alert rules, but no dashboard, so everyone who sets up monitoring draws the same panels from scratch.

Commit a dashboard JSON with ingestion rate, lag, RPC latency percentiles, RPC errors by kind and cursor restarts, built only on metrics that exist. Add it to the compose monitoring setup if there is one, or document how to import it.

**Done when:** the dashboard imports into a clean Grafana and every panel shows data from a running indexer.

#### 217. Test coverage in CI — `trivial`

CI runs the tests but never reports what they cover, so a PR that adds untested code looks the same as one that adds tests.

Run `node --test --experimental-test-coverage` (or c8) for each workspace, publish the summary in the job summary, and start with a threshold just below current coverage so it can only go up.

**Done when:** each CI run shows coverage per package, and lowering coverage below the threshold fails the run.

#### 218. Guide: indexing mainnet through a provider — `trivial`

The mainnet preset carries a warning that SDF does not run a free public mainnet RPC with useful retention, and the docs stop there. Mainnet is where most real use is.

Write `docs/mainnet.md`: choosing a provider, passing its key with `--rpc-header` (never in the URL), retention and what it means for backfill, page size and cost, and a `lens doctor` run that proves it works.

**Done when:** someone with a provider key can follow the guide to index one mainnet contract, and it is linked from the README.

#### 219. API cookbook — `trivial`

`openapi.json` and `/docs` say what each parameter does, not how to answer real questions with them.

Add `docs/api-cookbook.md` with copy-paste `curl | jq` recipes: latest transfers for a token, everything an address did, one transaction's events, paging through a range, and an incremental sync. Check that each recipe works against the fixture.

**Done when:** every recipe runs as written against `lens seed` data, and the API README links to it.

#### 220. Script to refresh the fixtures — `medium`

`fixtures/` holds a captured `getEvents` response and `testnet-specs.json`. They were captured by hand, and testnet resets will eventually make them unrepresentative, with no record of how to recreate them.

Add a script that re-captures both from testnet for a configured set of contracts, trims the result the same way the current fixture is trimmed, and writes it deterministically, so a refresh shows a reviewable diff.

**Done when:** running the script reproduces fixtures of the same shape, all tests pass on them, and `fixtures/README.md` documents it.

#### 221. Run CI on Windows and macOS — `medium`

CI runs only on Linux. The code relies on `rename` over an existing file in the cursor store, `tmpdir()` paths, and file locking in SQLite, all of which behave differently on Windows, and contributors on other systems find out first.

Add Windows and macOS to the test matrix, at least for the unit tests, and fix what fails.

**Done when:** the full test suite passes on all three systems in CI.

#### 222. One command for local development — `medium`

Working on the UI means building every workspace, seeding, starting the API, then starting Vite, across several terminals.

Add `npm run dev`, which builds once, seeds when no database exists, then runs the API and Vite together, with TypeScript watch mode on the packages so edits rebuild. Ctrl-C stops everything.

**Done when:** a fresh clone reaches a working UI with `npm ci && npm run dev`, and editing a package file reloads without a manual rebuild.

#### 223. Publish the packages to npm — `medium`

`@soroban-lens/ingest` and `@soroban-lens/store` are useful as libraries: a typed poller with retries and cursors, and a decoder with a conformance-tested store. They can only be used by cloning the repo. #54 covers a generated API client; this is the packages themselves.

Make the four packages publishable (`files`, `exports`, typings, README per package, no workspace-only paths), and publish them from the release workflow with npm provenance.

**Done when:** `npm install @soroban-lens/ingest` in an empty project can stream events with the README example.

#### 224. `lens doctor --json` — `trivial`

`lens doctor` prints a human report. CI pipelines, deploy scripts and the compose `doctor` service can only check its exit code, not which check failed.

Add `--json` to print the check results as JSON (name, status, detail) to stdout. Keep the exit codes as they are.

**Done when:** `lens doctor --json | jq '.[] | select(.status=="fail")'` lists the failures, and a test pins the shape.

#### 225. Synthetic data generator for large databases — `medium`

Every database used in tests and benches is either the small fixture or whatever a contributor happens to have indexed. Questions like "how does the UI behave with a million rows" (#64) or "is this query plan still good at scale" have nothing reproducible to run against. #98 adds benchmarks, but needs data to run on.

Add a script that writes N realistic events (SAC-shaped transfers, a long tail of contracts, nested values, a few undecodable rows) directly through the store, deterministically from a seed.

**Done when:** `node scripts/synth.js --events 1000000 --seed 1` builds the same database every time in a few minutes, and the bench docs use it.

---

## Not planned

Recorded so nobody spends a weekend on something we would decline:

- **Writing to the network.** soroban-lens observes; it does not submit
  transactions. Keeping it read-only is what makes it safe to point at mainnet.
- **A hosted public instance.** Operating one is a different project with
  different obligations.
- **Contract source verification.** Out of scope; that belongs with
  soroban-forge, which already knows about contract interfaces. Note that #33
  (reading a contract *spec* to decode events) is in scope and different.
- **Indexing non-Soroban Stellar operations.** Payments, offers and trustlines
  are Horizon's job and it does it well. This project is about contract events.
- **A general-purpose Stellar block explorer.** Stellar Expert exists.
