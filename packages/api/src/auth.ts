import type { IncomingMessage } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string): Buffer => createHash('sha256').update(value).digest();

/**
 * Optional API-key check.
 *
 * Keys are compared as SHA-256 digests with `timingSafeEqual`, so neither a key's
 * length nor how many leading characters matched leaks through response time.
 */
export class ApiKeyAuthenticator {
  readonly #digests: Buffer[];

  constructor(keys: string[]) {
    this.#digests = keys.map((k) => k.trim()).filter((k) => k !== '').map(digest);
  }

  /** Whether any key is configured. When false every request is allowed, as before auth existed. */
  get enabled(): boolean {
    return this.#digests.length > 0;
  }

  /** `X-API-Key: <key>` or `Authorization: Bearer <key>`. */
  presentedKey(req: IncomingMessage): string | undefined {
    const header = req.headers['x-api-key'];
    const direct = (Array.isArray(header) ? header[0] : header)?.trim();
    if (direct) return direct;
    const authorization = req.headers.authorization;
    const match = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
    return match?.[1]?.trim();
  }

  isAuthorized(req: IncomingMessage): boolean {
    if (!this.enabled) return true;
    const presented = this.presentedKey(req);
    if (!presented) return false;
    const candidate = digest(presented);
    // No early exit: every configured key is compared.
    let ok = false;
    for (const known of this.#digests) ok = timingSafeEqual(known, candidate) || ok;
    return ok;
  }
}
