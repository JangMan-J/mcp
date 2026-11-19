import { createHash } from 'node:crypto';

export class AuthError extends Error {
  constructor(readonly kind: 'auth-failure' | 'auth-unavailable', readonly reason: string) {
    super(`${kind}/${reason}`);
    this.name = 'AuthError';
  }
}
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

export type BearerChallenge = Readonly<Partial<Record<'resource_metadata' | 'scope' | 'error' | 'error_description' | 'error_uri', string>>>;
const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quotedString = String.raw`"(?:[^"\\\x00-\x1f\x7f]|\\[\x20-\x7e])*"`;
const param = new RegExp(`^(${token})[ \\t]*=[ \\t]*(${token}|${quotedString})$`, 'u');
const scheme = new RegExp(`^(${token})(?:[ \\t]+(.+))?$`, 'u');

/** Parse each field independently; a malformed field cannot supply a partial challenge. */
export function parseBearerChallenges(input: string | readonly string[]): BearerChallenge[] {
  return (typeof input === 'string' ? [input] : input).flatMap((line) => {
    const pieces: string[] = [];
    let quote = false, escape = false, start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) { escape = false; continue; }
      if (quote && ch === '\\') escape = true;
      else if (ch === '"') quote = !quote;
      else if (!quote && ch === ',') { pieces.push(line.slice(start, i)); start = i + 1; }
    }
    if (quote) return [];
    pieces.push(line.slice(start));
    const result: BearerChallenge[] = [];
    let entry: Record<string, string> | undefined, bearer = false, acceptsParams = false;
    for (const raw of pieces) {
      const piece = raw.trim();
      if (!piece) continue;
      let match = param.exec(piece);
      if (!match) {
        const next = scheme.exec(piece);
        if (!next) return [];
        entry = Object.create(null) as Record<string, string>;
        bearer = next[1]?.toLowerCase() === 'bearer';
        if (bearer) result.push(entry);
        acceptsParams = false;
        if (next[2] === undefined) continue;
        match = param.exec(next[2]);
        if (!match) {
          if (!bearer && /^[a-z\d._~+/=-]+$/iu.test(next[2])) continue;
          return [];
        }
        acceptsParams = true;
      }
      if (!entry || !acceptsParams) return [];
      const key = match[1]!.toLowerCase(), value = match[2]!;
      if (Object.hasOwn(entry, key)) return [];
      entry[key] = value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/gu, '$1') : value;
    }
    return result.map(({ resource_metadata, scope, error, error_description, error_uri }) => Object.fromEntries(
      Object.entries({ resource_metadata, scope, error, error_description, error_uri }).filter(([, v]) => v !== undefined),
    ));
  });
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
