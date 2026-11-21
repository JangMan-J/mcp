import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { startTestAuthorizationServer } from './fixtures/test-as.js';
import { OAuthAuthorization, SafeFetch, startLoopbackRedirect } from '../src/index.js';

it('redeems a real single-use PKCE code via the loopback callback and test AS', async () => {
  const redirect = await startLoopbackRedirect();
  const as = await startTestAuthorizationServer(redirect.redirectUri);
  const auth = new OAuthAuthorization({
    resource: as.resource, redirectUri: redirect.redirectUri, allowInsecureDev: true,
    fetch: new SafeFetch({ allowInsecureDev: true, allowAddress: host => host === '127.0.0.1' }),
    registrations: { [as.issuer]: { clientId: 'test-client', redirectUris: [redirect.redirectUri] } },
    consent: { async request() { return { decision: 'accept' }; } },
    redirect,
    browser: { async open(input) {
      // A synthetic browser translates the exact loopback AS origin to its test HTTP listener.
      const url = new URL(input);
      expect(url.origin).toBe(as.issuer.replace('http:', 'https:'));
      url.protocol = 'http:';
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Authorization response received.');
    } },
  });
  try {
    const initial = await fetch(as.resource);
    expect(initial.status).toBe(401);
    expect(await auth.onChallenge({ status: 401, resource: as.resource,
      wwwAuthenticate: initial.headers.get('www-authenticate')! }, new AbortController().signal)).toBe(true);
    const authorization = (await auth.headerFor(as.resource))!.authorization;
    expect((await fetch(as.resource, { headers: { authorization } })).status).toBe(200);
    expect(as.calls).toEqual([
      { method: 'GET', path: '/mcp' },
      { method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' },
      { method: 'GET', path: '/.well-known/oauth-authorization-server' },
      { method: 'GET', path: '/authorize' },
      { method: 'POST', path: '/token' },
      { method: 'GET', path: '/mcp' },
    ]);
  } finally { redirect.close(); await as.close(); }
});

it('[AUTH-DCR-1] forwards an opt-in JSON content-type, defaults to urlencoded, and rejects other types', async () => {
  const seen: Array<{ contentType?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk; });
    req.on('end', () => { seen.push({ contentType: req.headers['content-type'], body }); res.end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const href = `http://127.0.0.1:${port}`;
  const safe = new SafeFetch({ allowInsecureDev: true, allowAddress: host => host === '127.0.0.1' });
  try {
    const json = JSON.stringify({ client_name: 'test-client' });
    expect((await safe.fetch(`${href}/register`, { method: 'POST', body: json,
      headers: { 'content-type': 'application/JSON; charset=utf-8' } })).status).toBe(200);
    expect(seen[0]).toEqual({ contentType: 'application/json', body: json });
    expect((await safe.fetch(`${href}/token`, { method: 'POST', body: 'grant_type=x' })).status).toBe(200);
    expect(seen[1]).toEqual({ contentType: 'application/x-www-form-urlencoded', body: 'grant_type=x' });
    await expect(safe.fetch(`${href}/xml`, { method: 'POST', body: '<x/>',
      headers: { 'content-type': 'text/xml' } })).rejects.toThrow('fetch-content-type');
    expect(seen).toHaveLength(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it('revalidates redirects and sends no ambient authentication, with a body cap and deadline', async () => {
  const seen: Array<{ host?: string; auth?: string; cookie?: string; path?: string }> = [];
  const server = createServer((req, res) => {
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
