import { lookup } from 'node:dns/promises';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { FetchPort } from '@mcp-client/core';
import { AuthError, fail, secureUrl } from './protocol.js';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  blocked.addSubnet(ip, bits, 'ipv4');
}
blocked.addSubnet('::ffff:0:0', 96, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(ip, bits, 'ipv6');

export interface SafeFetchOptions {
  readonly allowInsecureDev?: boolean;
  /** Explicit host policy for an otherwise blocked resolved address. */
  readonly allowAddress?: (hostname: string, ip: string) => boolean;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export class SafeFetch implements FetchPort {
  constructor(private readonly options: SafeFetchOptions = {}) {}

  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 10_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const method = init.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') fail('fetch-method');
    if (method === 'POST' && typeof init.body !== 'string') fail('fetch-body');
    try {
      let url = secureUrl(input, this.options.allowInsecureDev);
      const auth = method === 'POST' ? new Headers(init.headers).get('authorization') : null;
      for (let hop = 0; ; hop++) {
        const response = await this.send(url, method, init.body as string | undefined, auth, signal);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (method !== 'GET' || init.redirect === 'error' || hop >= 3 || !location) fail('fetch-redirect');
        // Validate the raw Location before URL resolution can normalize suspicious characters.
        if (/[\s\\<>"'`|{}^]/u.test(location)) fail('fetch-redirect');
        const next = secureUrl(new URL(location, url).href, this.options.allowInsecureDev);
        if (url.protocol === 'https:' && next.protocol !== 'https:') fail('fetch-redirect');
        url = next;
      }
    } catch (error) {
      // Never surface Node/DNS error text or the peer's response body.
      if (signal.aborted) fail('fetch-timeout-or-aborted');
      if (error instanceof AuthError) throw error;
      return fail('fetch-network');
    }
  }

  private async send(url: URL, method: string, body: string | undefined, auth: string | null, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    const literal = isIP(hostname);
    const addresses = literal ? [{ address: hostname, family: literal }] : await new Promise<Awaited<ReturnType<typeof resolve>>>((res, rej) => {
      const abort = () => rej(new Error('aborted'));
      signal.addEventListener('abort', abort, { once: true });
      void resolve(hostname).then(res, rej).finally(() => signal.removeEventListener('abort', abort));
    });
    if (addresses.length === 0) fail('fetch-network');
    for (const { address, family } of addresses) {
      const denied = family === 4 ? blocked.check(address, 'ipv4') :
        family !== 6 || !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6');
      if (denied && !this.options.allowAddress?.(hostname, address)) fail('fetch-address-blocked');
    }
    const { address, family } = addresses[0]!;
    const maxBytes = this.options.maxBytes ?? 1024 * 1024;
    return await new Promise<Response>((resolve, reject) => {
      const send = url.protocol === 'https:' ? https : http;
      const req = send(url, {
        method, signal, agent: false, family,
        // Keep the URL hostname for HTTP Host and TLS verification. Pin the socket lookup.
        lookup: (_host, _opts, callback) => callback(null, address, family),
        ...(url.protocol === 'https:' ? { rejectUnauthorized: true } : {}),
        headers: { accept: 'application/json', ...(method === 'POST' ? {
          'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body!),
          ...(auth ? { authorization: auth } : {}),
        } : {}) },
      }, (res) => {
        const code = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (typeof value === 'string') headers.set(key, value);
        }
        res.on('error', reject);
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            reject(new AuthError('auth-failure', 'fetch-response-too-large'));
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('end', () => {
          try { resolve(new Response([204, 205, 304].includes(code) ? null : new Uint8Array(Buffer.concat(chunks)), { status: code, headers })); }
          catch (error) { reject(error); }
        });
      });
      req.on('error', reject);
      req.end(method === 'POST' ? body : undefined);
    });
  }
}

const resolve = (host: string) => lookup(host, { all: true });
