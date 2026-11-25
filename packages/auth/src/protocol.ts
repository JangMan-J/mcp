import { createHash } from 'node:crypto';
import { AuthError } from '@mcp/core';

export { AuthError, parseBearerChallenges, withAbort, type BearerChallenge } from '@mcp/core';
export function fail(reason: string): never { throw new AuthError('auth-failure', reason); }
export const cancelled = (): AuthError => new AuthError('auth-failure', 'cancelled');
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

/** RFC 6749 §2.3.1 HTTP Basic credential header with form-urlencoded client id and secret. */
export function basicAuthorization(clientId: string, clientSecret: string): string {
  const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
  return `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`;
}
