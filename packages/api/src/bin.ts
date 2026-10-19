#!/usr/bin/env node
/** `soroban-lens-api` — serve the query API over an indexed database. */
import { parseArgs } from 'node:util';
import { SqliteEventStore, createLogger } from '@soroban-lens/store';
import { createApiServer } from './server.js';

const USAGE = `
soroban-lens-api — HTTP query API over indexed Soroban events

Usage:
  soroban-lens-api [--db ./data/lens.db] [--port 8080]

Options:
  -d, --db <path>     SQLite file (default: ./data/lens.db, env LENS_DB_PATH)
  -p, --port <n>      Port to listen on (default: 8080, env LENS_API_PORT)
      --host <addr>   Bind address (default: 0.0.0.0, env LENS_API_HOST)
      --cors <origin> Access-Control-Allow-Origin (default: *, env LENS_CORS_ORIGIN)
  -h, --help          Show this help.

Optional features (both off by default):
  LENS_GRAPHQL=1                 Serve GraphQL at /graphql.
  LENS_GRAPHQL_MAX_DEPTH=<n>     Deepest query allowed (default 8).
  LENS_GRAPHQL_MAX_COMPLEXITY=<n> Highest estimated query cost (default 5000).
  LENS_WEBHOOKS=1                Serve webhook subscriptions at /webhooks.
  LENS_WEBHOOKS_TOKEN=<secret>   Require this bearer token on /webhooks (recommended).
  LENS_WEBHOOKS_ALLOW_PRIVATE=1  Allow loopback/private targets. Development only.
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    db: { type: 'string', short: 'd' },
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    cors: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const log = createLogger({ prefix: '[api]' });

const dbPath = values.db ?? process.env.LENS_DB_PATH ?? './data/lens.db';
const port = Number(values.port ?? process.env.LENS_API_PORT ?? 8080);
const host = values.host ?? process.env.LENS_API_HOST ?? '0.0.0.0';

const store = new SqliteEventStore({ path: dbPath, log });

/** A positive integer from the environment, or undefined when unset or unusable. */
function envInt(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
const graphqlMaxDepth = envInt('LENS_GRAPHQL_MAX_DEPTH');
const graphqlMaxComplexity = envInt('LENS_GRAPHQL_MAX_COMPLEXITY');
const webhookToken = process.env.LENS_WEBHOOKS_TOKEN;
const server = createApiServer({
  store,
  network: process.env.LENS_NETWORK ?? 'testnet',
  ...(values.cors ?? process.env.LENS_CORS_ORIGIN
    ? { corsOrigin: values.cors ?? (process.env.LENS_CORS_ORIGIN as string) }
    : {}),
  log,
  graphql: {
    enabled: process.env.LENS_GRAPHQL === '1',
    ...(graphqlMaxDepth !== undefined ? { maxDepth: graphqlMaxDepth } : {}),
    ...(graphqlMaxComplexity !== undefined ? { maxComplexity: graphqlMaxComplexity } : {}),
  },
  webhooks: {
    enabled: process.env.LENS_WEBHOOKS === '1',
    allowPrivateNetworks: process.env.LENS_WEBHOOKS_ALLOW_PRIVATE === '1',
    ...(webhookToken ? { authToken: webhookToken } : {}),
  },
});

server.listen(port, host, () => {
  log.info('listening', `listening on http://${host}:${port} (db: ${dbPath})`, { host, port, dbPath });
  log.info('listening', `openapi: http://${host}:${port}/openapi.json`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('shutdown', `${signal}, shutting down`, { signal });
    server.close(() => {
      void store.close().then(() => process.exit(0));
    });
  });
}
