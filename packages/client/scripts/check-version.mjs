// The client's version tracks the spec's: @soroban-lens/client@X means
// "generated from an API spec at version X". Fails when they disagree.
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const specVersion = read('../../api/openapi.json').info.version;
const clientVersion = read('../package.json').version;

if (specVersion !== clientVersion) {
  console.error(
    `@soroban-lens/client is at ${clientVersion} but packages/api/openapi.json is at ${specVersion}. ` +
      'Bump packages/client/package.json to match the spec.',
  );
  process.exit(1);
}
console.log(`client and spec agree on version ${specVersion}`);
