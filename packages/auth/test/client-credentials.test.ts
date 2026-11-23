import { generateKeyPairSync, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FetchPort } from '@mcp-client/core';
import {
  AuthError,
  ClientCredentialsAuth,
  MemoryCredentialStore,
  createPemAssertionSigner,
  createWebCryptoAssertionSigner,
  type AssertionSigningAlgorithm,
  type ClientCredentialsDiagnostic,
} from '../src/index.js';

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

describe('PEM signing and widened WebCrypto algorithms', () => {
  it('supports PKCS#8 PEM across all 7 algorithms (RS256/384/512, ES256/384/512, Ed25519 & Ed448 EdDSA)', async () => {
    const cases: Array<{
      readonly alg: AssertionSigningAlgorithm;
      readonly pair: { readonly publicKey: KeyObject; readonly privateKey: KeyObject };
      readonly hash: string | null;
      readonly dsaEncoding?: 'ieee-p1363';
    }> = [
      { alg: 'RS256', pair: generateKeyPairSync('rsa', { modulusLength: 2048 }), hash: 'sha256' },
      { alg: 'RS384', pair: generateKeyPairSync('rsa', { modulusLength: 2048 }), hash: 'sha384' },
      { alg: 'RS512', pair: generateKeyPairSync('rsa', { modulusLength: 2048 }), hash: 'sha512' },
      { alg: 'ES256', pair: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), hash: 'sha256', dsaEncoding: 'ieee-p1363' },
      { alg: 'ES384', pair: generateKeyPairSync('ec', { namedCurve: 'secp384r1' }), hash: 'sha384', dsaEncoding: 'ieee-p1363' },
      { alg: 'ES512', pair: generateKeyPairSync('ec', { namedCurve: 'secp521r1' }), hash: 'sha512', dsaEncoding: 'ieee-p1363' },
      { alg: 'EdDSA', pair: generateKeyPairSync('ed25519'), hash: null },
      { alg: 'EdDSA', pair: generateKeyPairSync('ed448'), hash: null },
    ];

    for (const c of cases) {
      const pem = c.pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
      let form = new URLSearchParams();
      const auth = new ClientCredentialsAuth({
        resource: RES,
        clientId: 'pem-client',
        privateKeyPem: pem,
        alg: c.alg,
        kid: `kid-${c.alg}`,
        fetch: fakeFetch((f) => { form = f; }),
        clock: { now: () => 1_700_000_000_000 },
        random: { bytes: (n) => new Uint8Array(n).fill(3) },
      });
      await auth.headerFor(RES);
      const assertion = form.get('client_assertion') ?? '';
      const [h, p, s] = assertion.split('.') as [string, string, string];
      expect(decode(h)).toEqual({ alg: c.alg, typ: 'JWT', kid: `kid-${c.alg}` });
      expect(decode(p)).toMatchObject({ iss: 'pem-client', sub: 'pem-client', aud: ISS, iat: 1_700_000_000, exp: 1_700_000_060 });
      expect(form.get('resource')).toBe(RES);
      expect(form.get('client_assertion_type')).toBe(JWT_BEARER);
      const ok = cryptoVerify(
        c.hash,
        Buffer.from(`${h}.${p}`),
        c.dsaEncoding ? { key: c.pair.publicKey, dsaEncoding: c.dsaEncoding } : c.pair.publicKey,
        Buffer.from(s, 'base64url'),
      );
      expect(ok, `signature failed for ${c.alg}`).toBe(true);
    }
  });

  it('supports PKCS#1 RSA, SEC1 EC, and omits alg via key-type inference', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPkcs1 = rsa.privateKey.export({ format: 'pem', type: 'pkcs1' }) as string;
    const rsaSigner = createPemAssertionSigner(rsaPkcs1);
    expect(rsaSigner.alg).toBe('RS256');
    const rsaSig = rsaSigner.sign(new TextEncoder().encode('msg')) as Uint8Array;
    expect(cryptoVerify('sha256', Buffer.from('msg'), rsa.publicKey, rsaSig)).toBe(true);

    for (const [curve, expectedAlg, hash] of [
      ['prime256v1', 'ES256', 'sha256'],
      ['secp384r1', 'ES384', 'sha384'],
      ['secp521r1', 'ES512', 'sha512'],
    ] as const) {
      const ec = generateKeyPairSync('ec', { namedCurve: curve });
      const sec1 = ec.privateKey.export({ format: 'pem', type: 'sec1' }) as string;
      const ecSigner = createPemAssertionSigner(sec1);
      expect(ecSigner.alg).toBe(expectedAlg);
      const ecSig = ecSigner.sign(new TextEncoder().encode('msg')) as Uint8Array;
      expect(cryptoVerify(hash, Buffer.from('msg'), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, ecSig)).toBe(true);
    }

    for (const ed of [generateKeyPairSync('ed25519'), generateKeyPairSync('ed448')]) {
      const edPem = ed.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
      const edSigner = createPemAssertionSigner(edPem);
      expect(edSigner.alg).toBe('EdDSA');
      const edSig = edSigner.sign(new TextEncoder().encode('msg')) as Uint8Array;
      expect(cryptoVerify(null, Buffer.from('msg'), ed.publicKey, edSig)).toBe(true);
    }
  });

  it('widens createWebCryptoAssertionSigner to RS384/RS512/ES384/ES512/Ed25519 and rejects mismatches', async () => {
    const webCases: Array<{
      readonly alg: AssertionSigningAlgorithm;
      readonly gen: AlgorithmIdentifier | RsaHashedKeyGenParams | EcKeyGenParams;
      readonly verify: AlgorithmIdentifier | EcdsaParams;
    }> = [
      { alg: 'RS384', gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-384' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
      { alg: 'RS512', gen: { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' }, verify: { name: 'RSASSA-PKCS1-v1_5' } },
      { alg: 'ES384', gen: { name: 'ECDSA', namedCurve: 'P-384' }, verify: { name: 'ECDSA', hash: 'SHA-384' } },
      { alg: 'ES512', gen: { name: 'ECDSA', namedCurve: 'P-521' }, verify: { name: 'ECDSA', hash: 'SHA-512' } },
      { alg: 'EdDSA', gen: { name: 'Ed25519' }, verify: { name: 'Ed25519' } },
    ];
    for (const c of webCases) {
      const pair = await crypto.subtle.generateKey(c.gen, false, ['sign', 'verify']) as CryptoKeyPair;
      const signer = createWebCryptoAssertionSigner(c.alg, pair.privateKey, 'w-kid');
      const input = new TextEncoder().encode('hello-webcrypto');
      const sig = await signer.sign(input);
      expect(await crypto.subtle.verify(c.verify, pair.publicKey, sig as Uint8Array<ArrayBuffer>, input)).toBe(true);
    }

    const p256 = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    expect(() => createWebCryptoAssertionSigner('ES384', p256.privateKey)).toThrow('signing-alg-mismatch');
    expect(() => createWebCryptoAssertionSigner('HS256' as AssertionSigningAlgorithm, p256.privateKey)).toThrow('unsupported-signing-alg');
  });

  it('rejects malformed, public, encrypted, mismatched, and ambiguous PEM configurations without leaking key material', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const pubPem = rsa.publicKey.export({ format: 'pem', type: 'spki' }) as string;
    const encryptedPem = rsa.privateKey.export({ format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase: 'pw' }) as string;
    const ecPem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const edPem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;

    expect(() => new ClientCredentialsAuth({ resource: RES, clientId: 'c', privateKeyPem: '   ' })).toThrow('not-configured');
    expect(() => createPemAssertionSigner('   ')).toThrow('invalid-private-key');

    const badToken = 'SECRET-PEM-MARKER-DO-NOT-LEAK';
    for (const bad of [`not-a-pem-${badToken}`, pubPem, encryptedPem]) {
      let caught: unknown;
      try { createPemAssertionSigner(bad); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(AuthError);
      expect((caught as Error).message).toContain('invalid-private-key');
      expect((caught as Error).message).not.toContain(badToken);
      expect((caught as Error).message).not.toContain('BEGIN');
    }

    expect(() => createPemAssertionSigner(rsaPem, { alg: 'HS256' as AssertionSigningAlgorithm })).toThrow('unsupported-signing-alg');
    expect(() => createPemAssertionSigner(rsaPem, { alg: 'ES256' })).toThrow('signing-alg-mismatch');
    expect(() => createPemAssertionSigner(ecPem, { alg: 'ES384' })).toThrow('signing-alg-mismatch');
    expect(() => createPemAssertionSigner(edPem, { alg: 'RS256' })).toThrow('signing-alg-mismatch');

    const dummySigner = createPemAssertionSigner(edPem);
    expect(() => new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c',
      signer: dummySigner,
      privateKeyPem: edPem,
    })).toThrow('invalid-config');
  });
});

describe('authServerMetadataUrl and tokenEndpoint overrides', () => {
  it('authServerMetadataUrl skips PRM, fetches AS metadata directly, enforces issuer pinning, and sends resource + scope', async () => {
    const log: string[] = [];
    let form = new URLSearchParams();
    const metaUrl = 'https://auth.override.test/custom/metadata';
    const tokenUrl = 'https://auth.override.test/oauth/token';
    let docIssuer = ISS;
    const fetch: FetchPort = {
      async fetch(url, init) {
        log.push(`${init.method ?? 'GET'} ${url}`);
        if (url === metaUrl) {
          return Response.json({
            issuer: docIssuer,
            token_endpoint: tokenUrl,
            token_endpoint_auth_methods_supported: ['private_key_jwt'],
            token_endpoint_auth_signing_alg_values_supported: ['EdDSA'],
          });
        }
        if (url === tokenUrl) {
          form = new URLSearchParams(String(init.body));
          return Response.json({ access_token: 'tok-meta', token_type: 'Bearer', expires_in: 120 });
        }
        return new Response(null, { status: 404 });
      },
    };
    const edPem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    const auth = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c1',
      privateKeyPem: edPem,
      authServerMetadataUrl: metaUrl,
      expectedIssuer: ISS,
      scopes: ['mcp:read'],
      fetch,
    });
    expect((await auth.headerFor(RES))?.authorization).toBe('Bearer tok-meta');
    expect(log.some((e) => e.includes('oauth-protected-resource'))).toBe(false);
    expect(log).toEqual([`GET ${metaUrl}`, `POST ${tokenUrl}`]);
    expect(form.get('resource')).toBe(RES);
    expect(form.get('scope')).toBe('mcp:read');

    const mismatched = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c1',
      secret: 'pw',
      authServerMetadataUrl: metaUrl,
      expectedIssuer: 'https://other.issuer.test',
      fetch,
    });
    await expect(mismatched.headerFor(RES)).rejects.toMatchObject({ reason: 'as-issuer-mismatch' });

    docIssuer = 'http://insecure-issuer.test';
    const badIssuer = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c1',
      secret: 'pw',
      authServerMetadataUrl: metaUrl,
      fetch,
    });
    await expect(badIssuer.headerFor(RES)).rejects.toMatchObject({ reason: 'invalid-url' });
  });

  it('tokenEndpoint override skips discovery for secret auth and requires expectedIssuer for private_key_jwt', async () => {
    const log: string[] = [];
    let form = new URLSearchParams();
    let authHeader: string | null = null;
    const tokenUrl = 'https://token.direct.test/v1/token';
    const fetch: FetchPort = {
      async fetch(url, init) {
        log.push(`${init.method ?? 'GET'} ${url}`);
        if (url === tokenUrl) {
          form = new URLSearchParams(String(init.body));
          authHeader = new Headers(init.headers).get('authorization');
          return Response.json({ access_token: 'tok-direct', token_type: 'Bearer', expires_in: 60 });
        }
        return new Response(null, { status: 404 });
      },
    };

    const secretAuth = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c-sec',
      secret: 'pw',
      tokenEndpoint: tokenUrl,
      scopes: ['read', 'write'],
      fetch,
    });
    expect((await secretAuth.headerFor(RES))?.authorization).toBe('Bearer tok-direct');
    expect(log).toEqual([`POST ${tokenUrl}`]);
    expect(authHeader).toBe(`Basic ${Buffer.from('c-sec:pw').toString('base64')}`);
    expect(Object.fromEntries(form)).toEqual({ grant_type: 'client_credentials', resource: RES, scope: 'read write' });

    const edPem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    expect(() => new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c-jwt',
      privateKeyPem: edPem,
      tokenEndpoint: tokenUrl,
      fetch,
    })).toThrow('expected-issuer-required');

    log.length = 0;
    const jwtAuth = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c-jwt',
      privateKeyPem: edPem,
      tokenEndpoint: tokenUrl,
      expectedIssuer: ISS,
      fetch,
    });
    expect((await jwtAuth.headerFor(RES))?.authorization).toBe('Bearer tok-direct');
    expect(log).toEqual([`POST ${tokenUrl}`]);
    const assertion = form.get('client_assertion') ?? '';
    expect(decode(assertion.split('.')[1]!)).toMatchObject({ aud: ISS, iss: 'c-jwt', sub: 'c-jwt' });
  });

  it('both authServerMetadataUrl and tokenEndpoint fetches metadata for issuer/algs and posts to overridden tokenEndpoint', async () => {
    const log: string[] = [];
    const metaUrl = 'https://auth.example.test/.well-known/oauth-authorization-server';
    const advertisedTokenUrl = 'https://auth.example.test/ignored-token';
    const overrideTokenUrl = 'https://auth.example.test/override-token';
    const fetch: FetchPort = {
      async fetch(url, init) {
        log.push(`${init.method ?? 'GET'} ${url}`);
        if (url === metaUrl) {
          return Response.json({
            issuer: ISS,
            token_endpoint: advertisedTokenUrl,
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
          });
        }
        if (url === overrideTokenUrl) {
          return Response.json({ access_token: 'tok-both', token_type: 'Bearer', expires_in: 60 });
        }
        return new Response(null, { status: 404 });
      },
    };
    const auth = new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c-both',
      secret: 'pw',
      authServerMetadataUrl: metaUrl,
      tokenEndpoint: overrideTokenUrl,
      fetch,
    });
    expect((await auth.headerFor(RES))?.authorization).toBe('Bearer tok-both');
    expect(log).toEqual([`GET ${metaUrl}`, `POST ${overrideTokenUrl}`]);
  });

  it('rejects insecure or hashed override URLs and enforces allowInsecureDev in constructor', async () => {
    expect(() => new ClientCredentialsAuth({
      resource: 'http://localhost:8080/mcp',
      clientId: 'c',
      secret: 'pw',
      tokenEndpoint: 'http://localhost:9000/token',
    })).toThrow('invalid-url');
    expect(() => new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c',
      secret: 'pw',
      tokenEndpoint: 'http://non-loopback.test/token',
      allowInsecureDev: true,
    })).toThrow('invalid-url');
    expect(() => new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c',
      secret: 'pw',
      tokenEndpoint: 'https://as.test/token#frag',
    })).toThrow('invalid-url');
    expect(() => new ClientCredentialsAuth({
      resource: RES,
      clientId: 'c',
      secret: 'pw',
      authServerMetadataUrl: 'https://as.test/meta#frag',
    })).toThrow('invalid-url');

    const devAuth = new ClientCredentialsAuth({
      resource: 'http://localhost:8080/mcp',
      clientId: 'c',
      secret: 'pw',
      tokenEndpoint: 'http://localhost:9000/token',
      allowInsecureDev: true,
      fetch: {
        async fetch() { return Response.json({ access_token: 'tok-dev', token_type: 'Bearer', expires_in: 60 }); },
      },
    });
    expect((await devAuth.headerFor('http://localhost:8080/mcp'))?.authorization).toBe('Bearer tok-dev');
  });
});
