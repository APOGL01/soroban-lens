/** Module 3 — Query API. */
export { createApiServer, shutdownApiServer } from './server.js';
export type { ApiServerOptions, ShutdownOptions } from './server.js';
export { ApiError } from './errors.js';
export type { ApiErrorBody } from './errors.js';
export {
  parseEventQuery,
  parseTopics,
  parseIds,
  parseFields,
  parseActivityQuery,
  assertContractId,
  MAX_BATCH_IDS,
} from './params.js';
