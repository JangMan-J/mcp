import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { beforeEach, expect, it, vi } from 'vitest';
import { discoverIssuer } from '../src/discovery.js';
import { runExchange } from '../src/conformance.js';
import { OAuthAuthorization, SafeFetch, openSystemBrowser } from '../src/index.js';

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

it('[AUTH-SSRF-3] pins the HTTPS socket to the validated address and preserves Host and SNI', async () => {
  await withHttps(async (port, seen) => {
    trust.ca = [cert];
    const response = await safe().fetch(`https://${HOST}:${port}${PRM}`);
    expect(await response.json()).toEqual({ ok: true });
    expect(lookup.mock.calls).toEqual([[HOST, { all: true }]]);
    expect(seen).toEqual([{ host: `${HOST}:${port}`, sni: HOST, path: PRM }]);
  });
});

it('[AUTH-PRM-4] aborts PRM discovery for an untrusted or hostname-mismatched certificate before sending HTTP', async () => {
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

it('[AUTH-SSRF-4] [AUTH-SSRF-5] [AUTH-SSRF-6] revalidates redirects and sends no ambient authentication, with a body cap and deadline', async () => {
  const seen: Array<{ host?: string; auth?: string; cookie?: string; path?: string }> = [];
  const server = createHttpServer((req, res) => {
    seen.push({ host: req.headers.host, auth: req.headers.authorization, cookie: req.headers.cookie, path: req.url });
    if (req.url === '/redirect') return res.writeHead(302, { Location: `http://localhost:${port}/hidden` }).end();
    if (req.url === '/chain') return res.writeHead(302, { Location: '/chain' }).end();
    if (req.url === '/large') return res.end('0123456789');
    if (req.url === '/hang') return;
    return res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const href = `http://127.0.0.1:${port}`;
  const safe = new SafeFetch({ allowInsecureDev: true, allowAddress: host => host === '127.0.0.1', maxBytes: 8 });
  try {
    expect(await (await safe.fetch(`${href}/ok`, { headers: { authorization: 'Bearer sentinel', cookie: 'session=sentinel' } })).json()).toEqual({});
    expect(seen[0]).toEqual({ host: `127.0.0.1:${port}`, auth: undefined, cookie: undefined, path: '/ok' });
    await expect(safe.fetch(`${href}/redirect`)).rejects.toThrow('fetch-address-blocked');
    expect(seen.some(x => x.path === '/hidden')).toBe(false);
    await expect(safe.fetch(`${href}/chain`)).rejects.toThrow('fetch-redirect');
    expect(seen.filter(x => x.path === '/chain')).toHaveLength(4);
    await expect(safe.fetch(`${href}/large`)).rejects.toThrow('fetch-response-too-large');
    const short = new SafeFetch({ allowInsecureDev: true, allowAddress: () => true, timeoutMs: 100 });
    await expect(short.fetch(`${href}/hang`)).rejects.toThrow('fetch-timeout-or-aborted');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});


it('[AUTH-URL-1] permits HTTP authorization endpoints only on loopback with explicit dev mode', async () => {
  const issuer = 'https://as.test';
  const endpoint = (host: string, options: { allowInsecureDev?: boolean }) => discoverIssuer({
    fetch: async () => Response.json({ issuer, authorization_endpoint: `http://${host}/authorize`,
      token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ['S256'] }),
  }, issuer, options, new AbortController().signal);
  await expect(endpoint('localhost', {})).rejects.toThrow('invalid-url');
  await expect(endpoint('localhost', { allowInsecureDev: false })).rejects.toThrow('invalid-url');
  expect((await endpoint('localhost', { allowInsecureDev: true })).authorizationEndpoint.href).toBe('http://localhost/authorize');
  await expect(endpoint('as.test', { allowInsecureDev: true })).rejects.toThrow('invalid-url');
});

it('[AUTH-RES-1] sends the root PRM identifier for authorization, code exchange, and refresh', async () => {
  const resource = 'https://mcp.test';
  await runExchange({ client: { prmLocation: 'root', tokenReplies: [{ body: {
    access_token: 'first', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 1,
  } }] }, script: [
    { do: 'challenge' }, { expect: 'open', url: 'https://as.test/authorize', match: { resource } },
    { expect: 'form', match: { resource, grant_type: 'authorization_code' } },
    { do: 'advance', ms: 1000 }, { expect: 'header', value: 'Bearer fixture-token-2' },
    { expect: 'form', index: 1, match: { resource, grant_type: 'refresh_token' } },
    { expect: 'header', url: `${resource}/other`, value: null },
  ] });
});

// Observe process creation without opening a desktop application.
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
beforeEach(() => spawn.mockReset());

it('[AUTH-URL-2] passes the HTTPS URL as one opaque argument to a fixed launcher without a shell', async () => {
  const child = new EventEmitter();
  const unref = vi.fn();
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('spawn'));
    return Object.assign(child, { unref });
  });

  const url = 'https://as.invalid/authorize?state=one&scope=read;write';
  const expected = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  await openSystemBrowser(url, new AbortController().signal);
  expect(spawn.mock.calls).toEqual([[...expected, { shell: false, stdio: 'ignore', detached: true }]]);
  expect(unref).toHaveBeenCalledOnce();
});

it('[AUTH-URL-2] does not spawn for a rejected URL or an already-cancelled launch', async () => {
  const signal = new AbortController().signal;
  await expect(openSystemBrowser('file:///example', signal)).rejects.toThrow('invalid-url');
  await expect(openSystemBrowser('https://as.invalid/`unsafe`', signal)).rejects.toThrow('invalid-url');
  await expect(openSystemBrowser('https://as.invalid/authorize', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).not.toHaveBeenCalled();
});
