# @soroban-lens/client

Typed TypeScript client for the soroban-lens query API.

```ts
import { createLensClient } from '@soroban-lens/client';

const lens = createLensClient('http://localhost:8080');
const { data, error } = await lens.GET('/contracts/{contractId}/events', {
  params: { path: { contractId }, query: { limit: 50 } },
});
```

Request parameters and response bodies are typed from
[`packages/api/openapi.json`](../api/openapi.json).

## How it is built

The generated types are not committed. `npm run build` here:

1. generates `src/schema.d.ts` from the spec with `openapi-typescript`;
2. checks that this package's `version` equals the spec's `info.version`;
3. compiles `src/index.ts` against the generated types.

If the spec changes in a way `src/index.ts` no longer fits, or the versions
drift, the build fails. The `client` job in `.github/workflows/ci.yml` runs this
on every change.

This package sits outside the root npm workspaces so it does not affect the
root lockfile; install and build it from this directory.
