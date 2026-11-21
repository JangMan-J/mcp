import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import { createServer, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { beforeEach, expect, it, vi } from 'vitest';
import { discoverIssuer } from '../src/discovery.js';
import { runExchange } from '../src/conformance.js';
import { AuthError, OAuthAuthorization, SafeFetch, openSystemBrowser } from '../src/index.js';

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

// ---- Dynamic client registration (opt-in) ----
type Posted = { url: string; body: Record<string, unknown>; headers: Headers };
function dcrHarness(options: { methods?: string[]; registrationEndpoint?: unknown; reply?: () => Response; redirectUri?: string;
  issuer?: string; dcr?: boolean; credentials?: Map<string, string> } = {}) {
  const resource = 'https://mcp.test/mcp';
  const posts: Posted[] = [];
  const tokens: Posted[] = [];
  const state = { issuer: options.issuer ?? 'https://as.test' };
  const store = options.credentials ?? new Map<string, string>();
  const fetcher = { async fetch(url: string, init?: RequestInit) {
    const u = new URL(url);
    if (u.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource, authorization_servers: [state.issuer] });
    if (u.pathname.startsWith('/.well-known/oauth-authorization-server')) return Response.json({
      issuer: state.issuer, authorization_endpoint: `${state.issuer}/authorize`, token_endpoint: `${state.issuer}/token`,
      code_challenge_methods_supported: ['S256'], registration_endpoint: options.registrationEndpoint ?? `${state.issuer}/register`,
      ...(options.methods ? { token_endpoint_auth_methods_supported: options.methods } : {}) });
    const entry = { url, body: init?.body ? (init.headers instanceof Headers && init.headers.get('Content-Type') === 'application/json'
      ? JSON.parse(init.body as string) : Object.fromEntries(new URLSearchParams(init.body as string))) : {}, headers: init?.headers as Headers };
    if (u.pathname === '/register') { posts.push(entry); return options.reply?.() ?? Response.json({ client_id: 'dyn-id', client_secret: 'dyn-secret' }, { status: 201 }); }
    if (u.pathname === '/token') { tokens.push(entry); return Response.json({ access_token: 'tok', token_type: 'Bearer', expires_in: 3600 }); }
    return new Response('nope', { status: 404 });
  } };
  const redirectUri = options.redirectUri ?? 'https://client.test/callback';
  const make = () => new OAuthAuthorization({ resource, redirectUri, fetch: fetcher, allowInsecureDev: redirectUri.startsWith('http:'),
    ...(options.dcr === false ? {} : { dynamicRegistration: { clientName: 'Test Client', softwareId: 'sw-1' } }),
    credentials: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async k => { store.delete(k); } },
    consent: { request: async () => ({ decision: 'accept' as const }) },
    browser: { open: async () => {} },
    redirect: { waitForCallback: async ({ state: s }) => new URLSearchParams({ code: 'c', state: s }) } });
  const flow = (auth = make()) => auth.onChallenge({ status: 401, resource, wwwAuthenticate: 'Bearer scope="read"' }, new AbortController().signal);
  return { posts, tokens, state, flow, make };
}

it('[AUTH-DCR-1] never POSTs the registration endpoint by default, even when advertised', async () => {
  const h = dcrHarness({ dcr: false });
  await expect(h.flow()).rejects.toThrow('no-registration-mechanism');
  expect(h.posts).toEqual([]);
});

it('[AUTH-DCR-1] registers once with dynamicRegistration and reuses the cached registration', async () => {
  const h = dcrHarness();
  await h.flow();
  await h.flow(h.make());
  expect(h.posts).toHaveLength(1);
  expect(h.posts[0]!.body).toMatchObject({ client_name: 'Test Client', software_id: 'sw-1', redirect_uris: ['https://client.test/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'read' });
  expect(h.tokens).toHaveLength(2);
});

it('[AUTH-DCR-2] sets application_type native for a loopback redirect and web otherwise', async () => {
  const native = dcrHarness({ redirectUri: 'http://127.0.0.1:8123/callback' });
  await native.flow();
  expect(native.posts[0]!.body['application_type']).toBe('native');
  const web = dcrHarness();
  await web.flow();
  expect(web.posts[0]!.body['application_type']).toBe('web');
});

it('selects token_endpoint_auth_method by preference and uses it at the token endpoint', async () => {
  const none = dcrHarness({ methods: ['client_secret_post', 'client_secret_basic', 'none'], reply: () => Response.json({ client_id: 'pub' }, { status: 201 }) });
  await none.flow();
  expect(none.posts[0]!.body['token_endpoint_auth_method']).toBe('none');
  expect(none.tokens[0]!.headers.get('Authorization')).toBeNull();
  expect(none.tokens[0]!.body).not.toHaveProperty('client_secret');
  const basic = dcrHarness({ methods: ['client_secret_post', 'client_secret_basic'] });
  await basic.flow();
  expect(basic.posts[0]!.body['token_endpoint_auth_method']).toBe('client_secret_basic');
  expect(basic.tokens[0]!.headers.get('Authorization')).toBe(`Basic ${Buffer.from('dyn-id:dyn-secret').toString('base64')}`);
  const post = dcrHarness({ methods: ['client_secret_post'] });
  await post.flow();
  expect(post.posts[0]!.body['token_endpoint_auth_method']).toBe('client_secret_post');
  expect(post.tokens[0]!.headers.get('Authorization')).toBeNull();
  expect(post.tokens[0]!.body).toMatchObject({ client_id: 'dyn-id', client_secret: 'dyn-secret' });
  const dflt = dcrHarness();
  await dflt.flow();
  expect(dflt.posts[0]!.body['token_endpoint_auth_method']).toBe('client_secret_basic');
});

it('re-registers when the issuer changes', async () => {
  const credentials = new Map<string, string>();
  const h = dcrHarness({ credentials });
  await h.flow();
  h.state.issuer = 'https://as2.test';
  await h.flow(h.make());
  expect(h.posts.map(p => p.url)).toEqual(['https://as.test/register', 'https://as2.test/register']);
});

it('maps a registration error to a typed AuthError without the secret', async () => {
  const h = dcrHarness({ reply: () => Response.json({ error: 'invalid_redirect_uri', client_secret: 'leaky-secret' }, { status: 400 }) });
  const error = await h.flow().then(() => undefined, (e: unknown) => e as Error);
  expect(error).toBeInstanceOf(AuthError);
  expect(error!.message).toContain('registration-failed');
  expect(error!.message).not.toContain('leaky-secret');
  const missing = dcrHarness({ reply: () => Response.json({ client_secret: 'leaky-secret' }, { status: 201 }) });
  await expect(missing.flow()).rejects.toThrow('registration-failed');
});

it('ignores an insecure registration_endpoint and records a diagnostic', async () => {
  const messages: string[] = [];
  const doc = { issuer: 'https://as.test', authorization_endpoint: 'https://as.test/a', token_endpoint: 'https://as.test/t',
    code_challenge_methods_supported: ['S256'], registration_endpoint: 'http://as.test/register' };
  const meta = await discoverIssuer({ fetch: async () => Response.json(doc) }, 'https://as.test', { onDiagnostic: m => messages.push(m) }, new AbortController().signal);
  expect(meta.registrationEndpoint).toBeUndefined();
  expect(messages).toHaveLength(1);
  const ok = await discoverIssuer({ fetch: async () => Response.json({ ...doc, registration_endpoint: 'https://as.test/register' }) }, 'https://as.test', {}, new AbortController().signal);
  expect(ok.registrationEndpoint?.href).toBe('https://as.test/register');
});
