/**
 * Start the built API as a child process against a database file.
 *
 * A child process rather than an in-process import: it measures what an
 * operator runs (`packages/api/dist/bin.js --db ... --port ...`, the same
 * invocation ci.yml uses), including HTTP, serialisation and the real server
 * defaults, and it works against any checkout via `--root`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startApi({ root, dbPath }) {
  const port = await freePort();
  const bin = join(root, 'packages/api/dist/bin.js');
  const child = spawn(process.execPath, [bin, '--db', dbPath, '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const collect = (chunk) => {
    output = (output + chunk).slice(-4000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) throw new Error(`the API exited before becoming healthy (${JSON.stringify(exited)}):\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`the API did not become healthy within 30s:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return {
    baseUrl,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/** GET a URL, drain the body, and fail on anything but 200. Returns the body size. */
export async function get(url) {
  const response = await fetch(url);
  const body = await response.arrayBuffer();
  if (response.status !== 200) {
    const hint =
      response.status === 429
        ? ' (the API rate limiter is throttling the benchmark; see packages/api/src/rate-limit.ts)'
        : '';
    throw new Error(`GET ${url} returned HTTP ${response.status}${hint}`);
  }
  return body.byteLength;
}
