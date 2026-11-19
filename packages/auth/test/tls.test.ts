import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { expect, it, vi } from 'vitest';
import { OAuthAuthorization, SafeFetch } from '../src/index.js';

// Control the policy lookup, but leave Node to open a real TLS socket.
const lookup = vi.hoisted(() => vi.fn(async (_host: string, _options: { all: true }) => [
  { address: '127.0.0.1', family: 4 },
]));
vi.mock('node:dns/promises', () => ({ lookup }));

// Scope trust to these requests so the test does not change the worker's trust store.
const trust = vi.hoisted(() => ({ ca: [] as string[] }));
vi.mock('node:https', async importOriginal => {
  const real = await importOriginal<typeof import('node:https')>();
  return { ...real, request(url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) {
    return real.request(url, { ...options, ca: trust.ca }, callback);
  } };
});

const HOST = 'auth-pin.invalid';
const WRONG_HOST = 'wrong-auth-pin.invalid';
const PRM = '/.well-known/oauth-protected-resource/mcp';
// Public, synthetic credentials, for this loopback listener only.
const key = readFileSync(new URL('./fixtures/loopback-test-key.pem', import.meta.url));
const cert = readFileSync(new URL('./fixtures/loopback-test-cert.pem', import.meta.url), 'utf8');

async function withHttps(run: (port: number, seen: { host?: string; sni: unknown; path?: string }[]) => Promise<void>) {
  lookup.mockClear();
  const seen: { host?: string; sni: unknown; path?: string }[] = [];
  const server = createServer({ key, cert }, (req, res) => {
    seen.push({ host: req.headers.host, sni: (req.socket as TLSSocket & { servername?: string }).servername, path: req.url });
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run((server.address() as { port: number }).port, seen);
  } finally {
    trust.ca = [];
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

const safe = () => new SafeFetch({ allowAddress: (host, ip) =>
  (host === HOST || host === WRONG_HOST) && ip === '127.0.0.1', timeoutMs: 2000 });

it('pins the HTTPS socket to the validated address and preserves Host and SNI', async () => {
  await withHttps(async (port, seen) => {
    trust.ca = [cert];
    const response = await safe().fetch(`https://${HOST}:${port}${PRM}`);
    expect(await response.json()).toEqual({ ok: true });
    expect(lookup.mock.calls).toEqual([[HOST, { all: true }]]);
    expect(seen).toEqual([{ host: `${HOST}:${port}`, sni: HOST, path: PRM }]);
  });
});

it('aborts PRM discovery for an untrusted or hostname-mismatched certificate before sending HTTP', async () => {
  await withHttps(async (port, seen) => {
    async function discover(host: string) {
      const origin = `https://${host}:${port}`;
      const resource = `${origin}/mcp`;
      const auth = new OAuthAuthorization({ resource, redirectUri: 'https://client.invalid/callback', fetch: safe() });
      return auth.onChallenge({ status: 401, resource, wwwAuthenticate: `Bearer resource_metadata="${origin}${PRM}"` },
        new AbortController().signal);
    }
    await expect(discover(HOST)).rejects.toThrow('auth-failure/fetch-network');
    trust.ca = [cert];
    await expect(discover(WRONG_HOST)).rejects.toThrow('auth-failure/fetch-network');
    expect(lookup.mock.calls).toEqual([[HOST, { all: true }], [WRONG_HOST, { all: true }]]);
    expect(seen).toEqual([]);
  });
});
