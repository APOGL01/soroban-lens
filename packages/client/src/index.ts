import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths, components, operations } from './schema.js';

/**
 * A typed client for the soroban-lens query API.
 *
 * Paths, parameters and response bodies are all derived from
 * `packages/api/openapi.json` at build time, so a change to the spec that this
 * wrapper no longer fits fails the build instead of shipping a stale client.
 *
 * @example
 * ```ts
 * const lens = createLensClient('http://localhost:8080');
 * const { data } = await lens.GET('/contracts/{contractId}/events', {
 *   params: { path: { contractId }, query: { limit: 50 } },
 * });
 * ```
 */
export function createLensClient(baseUrl: string, options: Omit<ClientOptions, 'baseUrl'> = {}) {
  return createClient<paths>({ ...options, baseUrl });
}
