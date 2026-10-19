# `@soroban-lens/api` — Module 3: Query API

Owner: **Person C**

Read-only HTTP API over the indexed events. Depends on Module 2's `EventStore`
trait and nothing else — it never touches SQLite or the RPC directly.

## Deliverable

```bash
npm run build -w @soroban-lens/api
node packages/api/dist/bin.js --db ./data/lens.db --port 8080

curl "localhost:8080/contracts/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC/events?limit=50"
```

## Routes

| Route | Purpose |
|---|---|
| `GET /health` | Liveness + a real write probe against the store. `503` when degraded. |
| `GET /stats` | Row counts, indexed ledger range, schema version. |
| `GET /status` | Stats plus every ingest stream's saved cursor — indexer lag without asking the RPC. |
| `GET /contracts` | Indexed contracts, most recently active first. |
| `GET /contracts/{id}/events` | Events for one contract. |
| `GET /contracts/{id}/activity` | Event counts per `minute`/`hour`/`day` bucket: `?bucket=hour&from=…&to=…`. Empty buckets are omitted. |
| `GET /contracts/{id}/topics` | Distinct first-topic values, ranked by frequency. |
| `GET /contracts/{id}/spec` | Where the contract's spec came from and which events it declares. `404` before any lookup. |
| `GET /events` | Events across all contracts. |
| `GET /events/stream` | Live events as Server-Sent Events, same filters as `/events` plus `contractId`. |
| `GET /events/{id}` | One event by RPC event id. |
| `GET /openapi.json` | The spec below, served from disk. |

Every event-returning route accepts `?fields=id,ledger,topics,value` to return only
those event properties. Omitted, every property is returned. `topicsXdr` and
`valueXdr` roughly double the payload, so leaving them out shrinks it. Unknown
names are a `400`.

Query parameters on the two event-list routes: `limit` (1–1000, default 50),
`cursor`, `direction` (`forward`/`backward`), `order` (`asc`/`desc`), `topic` (repeatable), `fromLedger`,
`toLedger`, `txHash`, `successfulOnly`.

Every event-returning route adds a `typed` field to events whose contract has
a spec and whose shape matches one of its declared events — the event's name
and its named, typed fields. It sits next to the generic `topics`/`value`,
never in place of them, and is simply absent otherwise. Typed views are
computed at read time from the stored raw XDR, so a spec fetched today applies
to events indexed last week.

## OpenAPI

[`openapi.json`](./openapi.json) is the committed spec and the source of truth;
the server reads that same file to serve `/openapi.json`, so the two cannot
drift. Generate a client with any OpenAPI 3.1 generator:

```bash
npx @openapitools/openapi-generator-cli generate \
  -i packages/api/openapi.json -g typescript-fetch -o ./generated-client
```

It is authored as JSON rather than YAML so that serving it needs no YAML parser
— a dependency the API would otherwise carry for one route.

A test asserts every implemented route appears in the spec, so adding a route
without documenting it fails CI.

## Things worth knowing before you build a client

**Decoded integers are strings.** `{"type":"i128","value":"4300000000"}`.
Soroban i128/u128 amounts exceed `Number.MAX_SAFE_INTEGER`, so a JSON number
would quietly lose precision on large transfers. Decoded `bytes` are hex
strings. Use `BigInt(event.value.value)` for arithmetic.

**Pagination is keyset.** Pass `nextCursor` back as `cursor`. `nextCursor` is
`null` on the last page — that is the termination condition, not an empty
`events` array. To page back, pass `prevCursor` as `cursor` with
`direction=backward`: paging forward and then back returns the original page
exactly. `prevCursor` is `null` on the first page. Offset pagination would skip or repeat rows while the indexer
writes behind you; this does not.

**Polling is cheap: `ETag` and `If-None-Match`.** `/events` and
`/contracts/{id}/events` send a weak `ETag` derived from the newest indexed
event id and the request's filter. Send it back as `If-None-Match` and an
unchanged poll is a `304` with no body, without running the query. These
responses are `Cache-Control: no-cache` (store, but revalidate), so a browser
sends the validator on its own. The tag tracks new events: pruning or
re-decoding rows without indexing anything new does not change it.

**Or don't poll: `GET /events/stream`.** A Server-Sent Events stream that takes
the same filters as `/events` (and `contractId`) and writes each newly indexed
event as it appears. Every message's `id` is the event id, so a dropped
connection resumes with `Last-Event-ID` (a browser `EventSource` does this by
itself; `?lastEventId=` is there for clients that cannot set headers) rather
than re-reading. With no `Last-Event-ID` the stream starts at the present.
The indexer is a separate process, so the API looks for new rows once per
second (not per stream) and keeps one id per stream, which is what keeps
memory flat across many streams. At most 1000 streams are open at once; more
get `503`.

**Topic filters are a positional prefix**, and `*` is a wildcard:
`?topic=transfer` matches any event whose first topic is `transfer`;
`?topic=*&topic=order` matches any event whose *second* topic is `order`.
At most four, because only four positions are indexed — but events can carry
more than four topics, so a prefix filter may need client-side narrowing to
become an exact match.

**Bad parameters are rejected, not clamped.** `?limit=5000` is a `400` naming
the offending parameter, not a silently truncated page. Errors are always
`{"error":{"code","message","parameter?"}}`.

**Open by default, lockable when it is reachable.** Out of the box there is no
auth, no rate limit and `Access-Control-Allow-Origin: *`, which suits localhost.
Set `LENS_API_KEYS` to require a key (`X-API-Key` or `Authorization: Bearer`)
and `LENS_RATE_LIMIT_RPS` to cap each client IP with a token bucket; over the
limit is `429` with `Retry-After`. Both are off unless set, and an unconfigured
instance behaves exactly as before. `/health`, `/openapi.json` and `/docs` are
never gated, so probes and the spec keep working. Set `LENS_CORS_ORIGIN` to
tighten CORS. See the table below.

## Why plain `node:http`

Read-only GET routes and a regex table. A dependency-light stack is a stated
goal, and the key check, token bucket and event stream are each small enough
(see `auth.ts`, `rate-limit.ts`, `stream.ts`) not to need a framework.

## Configuration

| Flag | Env | Default |
|---|---|---|
| `--db`, `-d` | `LENS_DB_PATH` | `./data/lens.db` |
| `--port`, `-p` | `LENS_API_PORT` | `8080` |
| `--host` | `LENS_API_HOST` | `0.0.0.0` |
| `--cors` | `LENS_CORS_ORIGIN` | `*` |
| | `LENS_RATE_LIMIT_RPS` | off. Requests per second allowed per client IP. |
| | `LENS_RATE_LIMIT_BURST` | `ceil(LENS_RATE_LIMIT_RPS)`. Bucket size: requests allowed back to back. |
| | `LENS_API_KEYS` | off. Comma-separated keys; when set, data routes require one. |
| | `LENS_TRUST_PROXY` | off. `1` to key the limiter on `X-Forwarded-For`; only behind a proxy that sets it. |
| `--shutdown-timeout` | `LENS_SHUTDOWN_TIMEOUT_MS` | `10000` |

On `SIGINT`/`SIGTERM` the API stops accepting connections, lets in-flight
requests finish (telling keep-alive clients to reconnect via `Connection: close`),
and only then closes the database. Requests still running after the shutdown
timeout are dropped.

## Tests

```bash
npm test -w @soroban-lens/api
```

21 tests. They boot a real HTTP server on an ephemeral port against an in-memory
store seeded from `fixtures/testnet-events.json`, so the suite exercises real
routing, status codes and JSON — no network, no mocked request objects.
