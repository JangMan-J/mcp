import { describe, expect, it } from 'vitest';
import type { FetchPort } from '@mcp-client/core';
import { AuthError, ClientCredentialsAuth, MemoryCredentialStore, createWebCryptoAssertionSigner, type ClientCredentialsDiagnostic } from '../src/index.js';

const RES = 'https://mcp.test/rpc';
const ISS = 'https://as.test/tenant';
const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString()) as Record<string, unknown>;

function fakeFetch(onToken: (form: URLSearchParams, headers: Headers) => void, meta: Record<string, unknown> = {}, log: string[] = []): FetchPort {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  let count = 0;
  return {
    async fetch(url, init) {
      log.push(`${init.method ?? 'GET'} ${url}`);
      if (url.includes('oauth-protected-resource')) return json({ resource: RES, authorization_servers: [ISS] });
      if (url.includes('oauth-authorization-server')) return json({ issuer: ISS, token_endpoint: 'https://as.test/token', ...meta });
      if (url === 'https://as.test/token') {
        count++;
        onToken(new URLSearchParams(String(init.body)), new Headers(init.headers));
        return json({ access_token: `tok-${count}`, token_type: 'Bearer', expires_in: 100 });
      }
      return new Response(null, { status: 404 });
    },
  };
}

describe('signing', () => {
  it('ES256 and RS256 WebCrypto assertions verify and carry required JWT claims', async () => {
    const es = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    const rs = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['sign', 'verify']);
    for (const [alg, pair, params] of [['ES256', es, { name: 'ECDSA', hash: 'SHA-256' }], ['RS256', rs, { name: 'RSASSA-PKCS1-v1_5' }]] as const) {
      let form = new URLSearchParams();
      const log: string[] = [];
      const signer = createWebCryptoAssertionSigner(alg, pair.privateKey, 'kid-1');
      const auth = new ClientCredentialsAuth({
        resource: RES, clientId: 'c', signer, fetch: fakeFetch((f) => { form = f; }, {}, log),
        clock: { now: () => 1_700_000_000_000 }, random: { bytes: (n) => new Uint8Array(n).fill(7) },
      });
      await auth.headerFor(RES);
      const assertion = form.get('client_assertion') ?? '';
      const [h, p, s] = assertion.split('.') as [string, string, string];
      expect(decode(h)).toEqual({ alg, typ: 'JWT', kid: 'kid-1' });
      const payload = decode(p);
      expect(payload).toMatchObject({ iss: 'c', sub: 'c', aud: ISS, iat: 1_700_000_000, exp: 1_700_000_060 });
      expect(typeof payload['jti']).toBe('string');
      expect(Object.fromEntries(form)).toEqual({
        grant_type: 'client_credentials', resource: RES, client_assertion_type: JWT_BEARER, client_assertion: assertion,
      });
      expect(log.some((entry) => entry.includes('register'))).toBe(false);
      expect(await crypto.subtle.verify(params, pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    }
  });

  it('rejects a public key', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    expect(() => createWebCryptoAssertionSigner('ES256', pair.publicKey)).toThrow();
  });
});

describe('grants', () => {
  it('client_secret_post form with resource and scope, secret from the store', async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set('k', 'pw');
    let form = new URLSearchParams();
    const fetch = fakeFetch((f) => { form = f; }, { token_endpoint_auth_methods_supported: ['client_secret_post'] });
    await new ClientCredentialsAuth({ resource: RES, clientId: 'c', credentialKey: 'k', credentials, scopes: ['a', 'b'], fetch }).headerFor(RES);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', resource: RES, scope: 'a b', client_id: 'c', client_secret: 'pw' });
  });

  it('client_secret_basic is the default', async () => {
    let auth: string | null = null;
    let form = new URLSearchParams();
    const fetch = fakeFetch((f, h) => { form = f; auth = h.get('authorization'); });
    await new ClientCredentialsAuth({ resource: RES, clientId: 'c', secret: 'pw', fetch }).headerFor(RES);
    expect(auth).toBe(`Basic ${Buffer.from('c:pw').toString('base64')}`);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', resource: RES });
  });

  it('refuses an AS that lists neither JWT nor secret methods it can use', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signer = createWebCryptoAssertionSigner('ES256', pair.privateKey);
    const fetch = fakeFetch(() => {}, { token_endpoint_auth_methods_supported: ['client_secret_basic'] });
    await expect(new ClientCredentialsAuth({ resource: RES, clientId: 'c', signer, fetch }).headerFor(RES)).rejects.toMatchObject({ reason: 'auth-method-unsupported' });
    const fetch2 = fakeFetch(() => {}, { token_endpoint_auth_methods_supported: ['private_key_jwt'], token_endpoint_auth_signing_alg_values_supported: ['RS256'] });
    await expect(new ClientCredentialsAuth({ resource: RES, clientId: 'c', signer, fetch: fetch2 }).headerFor(RES)).rejects.toMatchObject({ reason: 'signing-alg-unsupported' });
  });

  it('enforces expectedIssuer pinning before contacting an untrusted AS', async () => {
    const contacted: string[] = [];
    const fetch: FetchPort = {
      async fetch(url) {
        contacted.push(url);
        if (url.includes('oauth-protected-resource')) return Response.json({ resource: RES, authorization_servers: ['https://evil.test'] });
        return new Response(null, { status: 404 });
      },
    };
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: 'c', secret: 'pw', expectedIssuer: ISS, fetch });
    await expect(auth.headerFor(RES)).rejects.toEqual(new AuthError('auth-failure', 'issuer-mismatch'));
    expect(contacted.some((u) => u.includes('evil.test'))).toBe(false);
  });

  it('mid-flow AS change is an auth-failure', async () => {
    let now = 0;
    let adv = [ISS];
    const base = fakeFetch(() => {});
    const fetch: FetchPort = { fetch: async (u, i) => u.includes('oauth-protected-resource') ? Response.json({ resource: RES, authorization_servers: adv }) : base.fetch(u, i) };
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: 'c', secret: 'pw', fetch, clock: { now: () => now } });
    await auth.headerFor(RES);
    adv = ['https://other.test'];
    now = 1e7;
    await expect(auth.headerFor(RES)).rejects.toEqual(new AuthError('auth-failure', 'issuer-mismatch'));
  });

  it('coalesces concurrent acquisition, refreshes after expiry, and handles 401/403 challenges', async () => {
    let now = 1_000_000;
    let tokenCalls = 0;
    const base = fakeFetch(() => { tokenCalls++; });
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: 'c', secret: 'pw', fetch: base, clock: { now: () => now } });

    const parallel = await Promise.all([auth.headerFor(RES), auth.headerFor(RES), auth.headerFor(RES)]);
    expect(parallel.map((r) => r?.authorization)).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-1']);
    expect(tokenCalls).toBe(1);

    // Expired token triggers a fresh acquisition.
    now += 100_000;
    const renewed = await auth.headerFor(RES);
    expect(renewed?.authorization).toBe('Bearer tok-2');
    expect(tokenCalls).toBe(2);

    // Stale credentialVersion on 401 returns true without reacquiring; current version invalidates and reacquires.
    expect(await auth.onChallenge({ status: 401, credentialVersion: parallel[0]!.credentialVersion! }, new AbortController().signal)).toBe(true);
    expect(tokenCalls).toBe(2);
    expect(await auth.onChallenge({ status: 401, credentialVersion: renewed!.credentialVersion! }, new AbortController().signal)).toBe(true);
    expect(tokenCalls).toBe(3);
    expect((await auth.headerFor(RES))?.authorization).toBe('Bearer tok-3');

    // 403 insufficient_scope aborts machine credentials without reacquiring; plain 403 declines retry.
    await expect(auth.onChallenge({ status: 403, wwwAuthenticate: 'Bearer error="insufficient_scope", scope="admin"' }, new AbortController().signal))
      .rejects.toEqual(new AuthError('auth-failure', 'insufficient-scope'));
    expect(await auth.onChallenge({ status: 403 }, new AbortController().signal)).toBe(false);
    expect(tokenCalls).toBe(3);
  });

  it('cancels waiting callers on AbortSignal without aborting underlying single-flight work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const base = fakeFetch(() => {});
    const fetch: FetchPort = {
      async fetch(url, init) {
        if (url === 'https://as.test/token') await gate;
        return base.fetch(url, init);
      },
    };
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: 'c', secret: 'pw', fetch });
    const ac = new AbortController();
    const first = auth.headerFor(RES, undefined, { signal: ac.signal });
    const second = auth.headerFor(RES);
    ac.abort();
    await expect(first).rejects.toEqual(new AuthError('auth-failure', 'cancelled'));
    release();
    expect((await second)?.authorization).toBe('Bearer tok-1');
  });

  it('is not sent to other resources, validates config, and keeps secrets out of diagnostics/errors', async () => {
    expect(() => new ClientCredentialsAuth({ resource: RES, clientId: 'c', credentialKey: 'k' })).toThrow(new AuthError('auth-unavailable', 'not-configured'));
    const diagnostics: ClientCredentialsDiagnostic[] = [];
    const secret = 's3cret-value-XYZ';
    const auth = new ClientCredentialsAuth({
      resource: RES, clientId: 'c', secret, fetch: fakeFetch(() => {}),
      onDiagnostic: (e) => diagnostics.push(e),
    });
    expect(await auth.headerFor('https://other.test/rpc')).toBeUndefined();
    const res = await auth.headerFor(RES);
    await auth.onChallenge({ status: 401, credentialVersion: res!.credentialVersion! }, new AbortController().signal);
    expect(diagnostics).toEqual([
      { event: 'token-acquired', detail: 'as.test' },
      { event: 'token-invalidated' },
      { event: 'token-acquired', detail: 'as.test' },
    ]);
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('tok-1');
    expect(serialized).not.toContain('tok-2');
  });
});
