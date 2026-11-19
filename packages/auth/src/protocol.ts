import { createHash } from 'node:crypto';
import { AuthError } from '@mcp-client/core';

export { AuthError, parseBearerChallenges, type BearerChallenge } from '@mcp-client/core';
export function fail(reason: string): never { throw new AuthError('auth-failure', reason); }
export const hash = (input: string) => createHash('sha256').update(input).digest('base64url');
export const pkceChallenge = hash;
export const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);

export function secureUrl(input: string, dev = false): URL {
  if (typeof input !== 'string' || !/^https?:\/\//iu.test(input) || /[\s\\<>"'`|{}^]/u.test(input)) fail('invalid-url');
  let url: URL;
  try { url = new URL(input); } catch { return fail('invalid-url'); }
  if (url.username || url.password || (url.protocol !== 'https:' &&
    !(dev && url.protocol === 'http:' && isLoopback(url.hostname)))) fail('invalid-url');
  return url;
}

export function canonicalResource(input: string, preserveTrailingSlash = false): string {
  const url = secureUrl(input, true);
  url.hash = '';
  const path = preserveTrailingSlash ? url.pathname : url.pathname.replace(/\/$/u, '');
  return `${url.origin}${path}${url.search}`;
}

export function bearerValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z\d._~+/\-]+=*$/u.test(value)) fail('invalid-token');
  return value;
}

export function detach<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new AuthError('auth-failure', 'cancelled'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
