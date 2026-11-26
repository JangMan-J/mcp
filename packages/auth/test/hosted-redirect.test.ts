import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { request as tlsRequest } from 'node:https';
import { expect, it } from 'vitest';
import { OAuthAuthorization, startHostedRedirect } from '../src/index.js';

const key = readFileSync(new URL('./fixtures/loopback-test-key.pem', import.meta.url));
const cert = readFileSync(new URL('./fixtures/loopback-test-cert.pem', import.meta.url), 'utf8');

const CALLBACK = 'https://callbacks.test/oauth/mcp/callback';

/** Issue a real request at the listener, asserting the Host header the way a proxy would. */
async function hit(port: number, target: string, options: { host?: string; method?: string; forwarded?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', path: target, method: options.method ?? 'GET',
      headers: {
        host: options.host ?? 'callbacks.test',
        ...(options.forwarded === undefined ? {} : { 'x-forwarded-host': options.forwarded }),
      } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const port = (listening: string) => Number(new URL(listening).port);

it('serves a public callback host and resolves the authorization that asked for it', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK });
  try {
    expect(new URL(redirect.listening).pathname).toBe('/oauth/mcp/callback');
    const signal = new AbortController().signal;
    const waiting = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'state-one', signal });
    const response = await hit(port(redirect.listening), '/oauth/mcp/callback?code=code-1&state=state-one&iss=https%3A%2F%2Fas.test');
    expect(response.status).toBe(200);
    expect(response.body).toContain('Authorization response received');
    const params = await waiting;
    expect(Object.fromEntries(params)).toEqual({ code: 'code-1', state: 'state-one', iss: 'https://as.test' });
  } finally { redirect.close(); }
});

it('refuses callbacks it did not ask for: wrong host, wrong path, other methods, unknown state', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK });
  try {
    const base = port(redirect.listening);
    const stated = '/oauth/mcp/callback?code=code-1&state=state-live';
    expect((await hit(base, stated, { host: 'evil.test' })).status).toBe(404);
    expect((await hit(base, '/oauth/mcp/other?code=code-1&state=state-live')).status).toBe(404);
    expect((await hit(base, stated, { method: 'POST' })).status).toBe(404);
    // A callback with no pending authorization never resolves and yields no state echo.
    const unknown = await hit(base, '/oauth/mcp/callback?code=code-1&state=state-absent');
    expect(unknown.status).toBe(400);
    expect(unknown.body).toBe('');

    const waiting = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'state-live', signal: new AbortController().signal });
    await hit(base, stated);
    expect((await waiting).get('state')).toBe('state-live');
    // Single use: the same state cannot be replayed once settled.
    expect((await hit(base, stated)).status).toBe(400);
  } finally { redirect.close(); }
});

it('accepts a proxied callback host only when the proxy hop is trusted', async () => {
  const trusted = await startHostedRedirect({ redirectUri: CALLBACK, trustProxy: true });
  try {
    const waiting = trusted.waitForCallback({ redirectUri: CALLBACK, state: 'proxied', signal: new AbortController().signal });
    // The proxy talks plain HTTP to the loopback listener and names the public host in X-Forwarded-Host.
    const response = await hit(port(trusted.listening), '/oauth/mcp/callback?code=c&state=proxied',
      { host: '127.0.0.1', forwarded: 'callbacks.test' });
    expect(response.status).toBe(200);
    expect((await waiting).get('code')).toBe('c');
  } finally { trusted.close(); }

  const untrusted = await startHostedRedirect({ redirectUri: CALLBACK, timeoutMs: 20 });
  try {
    const response = await hit(port(untrusted.listening), '/oauth/mcp/callback?code=c&state=proxied',
      { host: '127.0.0.1', forwarded: 'callbacks.test' });
    expect(response.status).toBe(404);
  } finally { untrusted.close(); }
});

it('keeps concurrent authorizations apart by state', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK });
  try {
    const base = port(redirect.listening);
    const signal = new AbortController().signal;
    const first = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'a', signal });
    const second = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'b', signal });
    await hit(base, '/oauth/mcp/callback?code=for-b&state=b');
    await hit(base, '/oauth/mcp/callback?code=for-a&state=a');
    expect((await first).get('code')).toBe('for-a');
    expect((await second).get('code')).toBe('for-b');
  } finally { redirect.close(); }
});

it('reports a lapsed callback as an OAuth error instead of hanging', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK, timeoutMs: 20 });
  try {
    const params = await redirect.waitForCallback({
      redirectUri: CALLBACK, state: 'slow', signal: new AbortController().signal,
    });
    expect(params.get('error')).toBe('timeout');
  } finally { redirect.close(); }
});

it('cancels waiters on abort and on close', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK, timeoutMs: 60_000 });
  const controller = new AbortController();
  const aborted = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'abort-me', signal: controller.signal });
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ reason: 'cancelled' });
  const closed = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'close-me', signal: new AbortController().signal });
  redirect.close();
  await expect(closed).rejects.toMatchObject({ reason: 'cancelled' });
  await expect(redirect.waitForCallback({ redirectUri: CALLBACK, state: 'after', signal: new AbortController().signal }))
    .rejects.toMatchObject({ reason: 'invalid-redirect-uri' });
});

it('rejects a different redirect URI, a duplicate state, and an exhausted allowance', async () => {
  const redirect = await startHostedRedirect({ redirectUri: CALLBACK, maxPending: 1 });
  try {
    const signal = new AbortController().signal;
    await expect(redirect.waitForCallback({ redirectUri: 'https://callbacks.test/other', state: 'x', signal }))
      .rejects.toMatchObject({ reason: 'invalid-redirect-uri' });
    const held = redirect.waitForCallback({ redirectUri: CALLBACK, state: 'held', signal });
    await expect(redirect.waitForCallback({ redirectUri: CALLBACK, state: 'held', signal }))
      .rejects.toMatchObject({ reason: 'duplicate-state' });
    await expect(redirect.waitForCallback({ redirectUri: CALLBACK, state: 'second', signal }))
      .rejects.toMatchObject({ reason: 'redirect-busy' });
    redirect.close();
    await expect(held).rejects.toMatchObject({ reason: 'cancelled' });
  } finally { redirect.close(); }
});

it('rejects an insecure public callback and a redirect URI that already carries a response', async () => {
  await expect(startHostedRedirect({ redirectUri: 'http://callbacks.test/callback' })).rejects.toMatchObject({ reason: 'invalid-url' });
  // Loopback http stays available for desktop development, and only then.
  const dev = await startHostedRedirect({ redirectUri: 'http://127.0.0.1:4321/callback', allowInsecureDev: true });
  dev.close();
  await expect(startHostedRedirect({ redirectUri: 'https://callbacks.test/callback', maxPending: 0 }))
    .rejects.toMatchObject({ reason: 'invalid-max-pending' });
  await expect(startHostedRedirect({ redirectUri: 'https://callbacks.test/callback?code=leak' }))
    .rejects.toMatchObject({ reason: 'invalid-redirect-uri' });
  await expect(startHostedRedirect({ redirectUri: 'https://callbacks.test/callback#fragment' }))
    .rejects.toMatchObject({ reason: 'invalid-redirect-uri' });
});

it('terminates TLS in-process when no proxy does', async () => {
  const redirect = await startHostedRedirect({ redirectUri: 'https://callbacks.test/callback', tls: { key, cert } });
  try {
    expect(redirect.listening.startsWith('https://')).toBe(true);
    const waiting = redirect.waitForCallback({ redirectUri: 'https://callbacks.test/callback', state: 'tls', signal: new AbortController().signal });
    const response = await new Promise<number>((resolve, reject) => {
      const req = tlsRequest({ port: port(redirect.listening), host: '127.0.0.1', path: '/callback?code=c&state=tls',
        headers: { host: 'callbacks.test' }, rejectUnauthorized: false }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });
    expect(response).toBe(200);
    expect((await waiting).get('code')).toBe('c');
  } finally { redirect.close(); }
});

it('completes an interactive OAuth authorization end to end through a hosted callback', async () => {
  const resource = 'https://mcp.test/mcp';
  const issuer = 'https://as.test';
  const forms: Record<string, string>[] = [];
  const redirect = await startHostedRedirect({ redirectUri: 'https://callbacks.test/oauth/mcp/callback' });
  try {
    const auth = new OAuthAuthorization({
      resource,
      redirectUri: redirect.redirectUri,
      redirect,
      registrations: { [issuer]: { clientId: 'fixture-client', redirectUris: [redirect.redirectUri] } },
      consent: { async request() { return { decision: 'accept' as const }; } },
      browser: {
        async open(url) {
          const authorize = new URL(url);
          // Play the authorization server: bounce the browser back to the hosted callback.
          queueMicrotask(() => {
            void hit(port(redirect.listening), `/oauth/mcp/callback?code=code-1&state=${authorize.searchParams.get('state')}&iss=${encodeURIComponent(issuer)}`);
          });
        },
      },
      fetch: {
        async fetch(url, init) {
          if (url === 'https://mcp.test/.well-known/oauth-protected-resource/mcp') {
            return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['read'] });
          }
          if (url === 'https://as.test/.well-known/oauth-authorization-server') {
            return Response.json({ issuer, authorization_endpoint: 'https://as.test/authorize',
              token_endpoint: 'https://as.test/token', code_challenge_methods_supported: ['S256'] });
          }
          if (url === 'https://as.test/token' && init?.method === 'POST') {
            forms.push(Object.fromEntries(new URLSearchParams(String(init.body))));
            return Response.json({ access_token: 'hosted', token_type: 'Bearer', expires_in: 60 });
          }
          return new Response(null, { status: 404 });
        },
      },
    });
    expect(await auth.onChallenge({ status: 401, resource, wwwAuthenticate: 'Bearer' }, new AbortController().signal)).toBe(true);
    expect(forms[0]).toMatchObject({ grant_type: 'authorization_code', redirect_uri: redirect.redirectUri });
    expect((await auth.headerFor(resource))?.authorization).toBe('Bearer hosted');
  } finally { redirect.close(); }
});
