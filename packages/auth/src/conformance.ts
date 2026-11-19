import { deepStrictEqual, equal, ok, AssertionError } from 'node:assert/strict';
import type { AuthChallenge, FetchPort } from '@mcp-client/core';
import { AuthError, ConfiguredBearer, MemoryCredentialStore, OAuthAuthorization, SafeFetch, canonicalResource, parseBearerChallenges, pkceChallenge } from './index.js';
import type { AuthorizationPrompt, OAuthOptions } from './index.js';

const RESOURCE = 'https://mcp.test/rpc';
const ISSUER = 'https://as.test/tenant';
const REDIRECT = 'http://127.0.0.1:4321/callback';
const CODE = 'fixture-code';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
interface Case {
  readonly status?: 401 | 403;
  readonly challenge?: string;
  readonly requestUrl?: string;
  readonly operation?: string;
  readonly error?: string;
  readonly retry?: boolean;
}
interface Config {
  resource?: string;
  bearer?: boolean;
  bearerRefresh?: boolean;
  prmLocation?: 'header' | 'path' | 'root';
  prm?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  metadataLocation?: number;
  registration?: 'pre' | 'cimd' | 'both' | 'prompt' | 'none';
  cimdDocument?: Record<string, unknown>;
  consent?: 'accept' | 'decline' | 'cancel' | 'absent';
  callback?: { iss?: string | null; state?: string; error?: string; redirect_uri?: string };
  redirectUri?: string;
  offlineAccess?: boolean;
  tokenReplies?: Array<{ status?: number; body: Record<string, unknown> }>;
}
function record(value: unknown): Record<string, unknown> {
  ok(value && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, unknown>;
}
function fields(actual: unknown, expected: unknown) {
  const obj = record(actual);
  for (const [key, value] of Object.entries(record(expected))) deepStrictEqual(obj[key], value, `field ${key}`);
}

const mutants = new Set(['no-provider', 'wrong-scope', 'wrong-issuer-policy', 'allow-pkce-plain', 'always-decline',
  'drop-resource', 'ignore-redirect-location', 'no-ssrf-guard', 'bad-pkce', 'ignore-bearer-challenge', 'preemptive-bearer', 'allow-cross-resource', 'refresh-on-forbidden', 'prefer-cimd', 'allow-invalid-redirect', 'lose-stored-refresh']);

interface WireFrame {
  direction: 'client' | 'server';
  endpoint: 'mcp' | 'oauth' | 'registration' | 'other';
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  message?: unknown;
}
export interface ExchangeObservation { frames: WireFrame[]; mcpEndpoint?: string; zeroWire?: boolean }

/** Map synthetic `*.test` hosts to loopback `*.test.localhost` for recorded transcripts. */
function loopback<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.test)(?![A-Za-z0-9.-])/gu, '$1.localhost')) as T;
}

/** Run a scripted auth exchange; unknown actions and assertions are errors, not skipped steps. */
export async function runExchange(fixture: unknown, mutant?: string): Promise<ExchangeObservation> {
  const fx = record(fixture);
  if (mutant !== undefined && !mutants.has(mutant)) throw new Error(`unknown auth mutant: ${mutant}`);
  if (fx['expect'] !== undefined) equal(Object.keys(record(fx['expect'])).length, 0, 'put auth assertions in the script');
  const config = record(fx['client'] ?? {}) as Config;
  const script = fx['script'];
  ok(Array.isArray(script) && script.length, 'empty auth script');
  let assertions = 0;
  let now = 0;
  const resource = config.resource ?? RESOURCE;
  const redirectUri = mutant === 'allow-invalid-redirect' ? REDIRECT : config.redirectUri ?? REDIRECT;
  const issuer = typeof config.metadata?.['issuer'] === 'string' ? config.metadata['issuer'] : ISSUER;
  let prm = config.prm;
  let metadata = config.metadata;
  let callbackConfig = config.callback;
  const fetches: { method: string; url: string; form?: Record<string, string>; redirect?: RequestRedirect }[] = [];
  const opens: URL[] = [];
  const frames: WireFrame[] = [];
  const classify = (url: string): WireFrame['endpoint'] => {
    let u: URL;
    try { u = new URL(url); } catch { return 'other'; }
    const r = new URL(resource);
    if (u.origin === r.origin && u.pathname === r.pathname && !u.search) return 'mcp';
    if (/\/register\/?$/u.test(u.pathname)) return 'registration';
    if (/\.well-known|\/(token|authorize)\/?$|metadata\.json$/u.test(u.pathname)) return 'oauth';
    return 'other';
  };
  const recordClient = (url: string, method: string, headers?: HeadersInit) => {
    const h = headers ? Object.fromEntries(new Headers(headers)) : undefined;
    frames.push(loopback({ direction: 'client' as const, endpoint: classify(url), method, url, ...(h && Object.keys(h).length ? { headers: h } : {}) }));
  };
  const prompts: AuthorizationPrompt[] = [];
  const diagnostics: string[] = [];
  const store = new MemoryCredentialStore();
  const writes: { key: unknown; value: string }[] = [];
  let tokenNumber = 0;
  let bearerNumber = 1;
  let closeCallback: ((params: URLSearchParams) => void) | undefined;
  const inner: FetchPort = { async fetch(url, request) {
    const method = request.method ?? 'GET';
    const form = method === 'POST' ? new URLSearchParams(String(request.body)) : undefined;
    if (mutant === 'drop-resource') form?.delete('resource');
    fetches.push({ method, url, ...(form ? { form: Object.fromEntries(form) } : {}), ...(request.redirect ? { redirect: request.redirect } : {}) });
    const origin = new URL(resource).origin;
    const root = `${origin}/.well-known/oauth-protected-resource`;
    const prmUrl = config.prmLocation === 'path' ? `${root}${new URL(resource).pathname}` :
      config.prmLocation === 'root' ? root : `${origin}/custom-prm`;
    if (url === prmUrl) return Response.json({ resource: config.prmLocation === 'root' ? origin : resource, authorization_servers: [ISSUER], scopes_supported: ['read'], ...prm });
    const asLocation = [
      'https://as.test/.well-known/oauth-authorization-server/tenant',
      'https://as.test/.well-known/openid-configuration/tenant',
      'https://as.test/tenant/.well-known/openid-configuration',
      'https://as.test/.well-known/oauth-authorization-server',
      'https://second.test/.well-known/oauth-authorization-server',
    ];
    if (url === asLocation[config.metadataLocation ?? 0] || (url === asLocation[4] && metadata?.['issuer'] === 'https://second.test')) {
      const doc: Record<string, unknown> = { issuer: ISSUER, authorization_endpoint: 'https://as.test/authorize',
        token_endpoint: 'https://as.test/token', code_challenge_methods_supported: ['S256'], ...metadata };
      if (mutant === 'allow-pkce-plain') doc['code_challenge_methods_supported'] = ['S256'];
      if (mutant === 'wrong-issuer-policy') doc['authorization_response_iss_parameter_supported'] = false;
      return Response.json(doc);
    }
    if (url === 'https://client.test/metadata.json') return Response.json({ client_id: url, client_name: 'Fixture client', redirect_uris: [REDIRECT], ...config.cimdDocument });
    if ((url === 'https://as.test/token' || url === 'https://second.test/token') && method === 'POST') {
      const next = config.tokenReplies?.[tokenNumber];
      tokenNumber++;
      return Response.json(next?.body ?? { token_type: 'Bearer', access_token: `fixture-token-${tokenNumber}` }, { status: next?.status ?? 200 });
    }
    return new Response(null, { status: 404 });
  } };
  const fetcher: FetchPort = { async fetch(url, request) {
    recordClient(url, request.method ?? 'GET', request.headers);
    const res = await inner.fetch(url, request);
    let message: unknown;
    if (/json/iu.test(res.headers.get('content-type') ?? '')) { try { message = await res.clone().json(); } catch { /* not JSON */ } }
    frames.push(loopback({ direction: 'server' as const, endpoint: classify(url), url, headers: { ...Object.fromEntries(res.headers), status: String(res.status) },
      ...(message !== undefined ? { message } : {}) }));
    return res;
  } };
  const registration = { clientId: 'fixture-client', redirectUris: [REDIRECT] };
  const oauthOptions: OAuthOptions = { resource, redirectUri, serverLabel: 'Fixture MCP', allowInsecureDev: true,
    fetch: fetcher, credentials: {
      get: key => store.get(key), delete: key => store.delete(key), async set(key, value) {
        if (mutant === 'lose-stored-refresh') return;
        writes.push({ key: JSON.parse(key), value });
        await store.set(key, value);
      },
    }, clock: { now: () => now }, skewMs: 0,
    offlineAccess: config.offlineAccess ?? false,
    random: { bytes: n => n === 32 ? Buffer.from(VERIFIER, 'base64url') : Buffer.alloc(n, 65) },
    onDiagnostic: text => diagnostics.push(text),
    ...(config.registration === 'cimd' || config.registration === 'both' ? { cimd: { clientIdUrl: 'https://client.test/metadata.json', redirectUris: [REDIRECT], selfCheck: true } } : {}),
    ...(!config.registration || config.registration === 'pre' || (config.registration === 'both' && mutant !== 'prefer-cimd') ? { registrations: { [ISSUER]: registration } } : {}),
    ...(config.consent !== 'absent' ? { consent: { async request(prompt) {
      prompts.push(prompt);
      const decision = mutant === 'always-decline' ? 'decline' : config.consent === 'absent' ? 'cancel' : config.consent ?? 'accept';
      return decision === 'accept' ? { decision, registration } : { decision };
    } } } : {}),
    redirect: { async waitForCallback() { return new Promise(resolve => { closeCallback = resolve; }); } },
    browser: { async open(url) {
      const parsed = new URL(url);
      opens.push(parsed);
      recordClient(url, 'GET');
      frames[frames.length - 1]!.endpoint = 'oauth';
      const values = new URLSearchParams({ code: CODE, state: callbackConfig?.state ?? parsed.searchParams.get('state')! });
      if (callbackConfig?.iss !== null) values.set('iss', callbackConfig?.iss ?? issuer);
      if (callbackConfig?.error) {
        values.set('error', 'access_denied');
        values.set('error_description', callbackConfig.error);
        values.set('error_uri', 'https://as.test/error');
      }
      if (callbackConfig?.redirect_uri) values.set('redirect_uri', callbackConfig.redirect_uri);
      ok(closeCallback, 'redirect listener must be armed before opening browser');
      closeCallback(values);
    } },
  };
  const makeProvider = () => config.bearer ? new ConfiguredBearer({ resource, token: async () => `configured-${bearerNumber}`,
    ...(config.bearerRefresh ? { refresh: async () => { bearerNumber++; } } : {}) }) : new OAuthAuthorization(oauthOptions);
  const constructionCheck = script.length === 1 && record(script[0])['expect'] === 'construction-error';
  if (constructionCheck) {
    const step = record(script[0]);
    ok(!Object.hasOwn(step, 'do') && !Object.hasOwn(step, 'server'), 'expected one step discriminator');
    let error: unknown;
    try { makeProvider(); } catch (caught) { error = caught; }
    ok(error instanceof AuthError, 'expected a typed construction error');
    equal(error.message, record(script[0])['value']);
    return { frames: [], zeroWire: true };
  }
  const provider = makeProvider();
  const statusFor = (step: Case): AuthChallenge => {
    const header = step.challenge ?? (config.prmLocation === 'root' || config.prmLocation === 'path' ? 'Bearer' : 'Bearer resource_metadata="https://mcp.test/custom-prm"');
    return { status: mutant === 'refresh-on-forbidden' ? 401 : step.status ?? 401, resource: step.requestUrl ?? resource, operation: step.operation ?? 'server/discover',
      wwwAuthenticate: mutant === 'ignore-redirect-location' ? 'Bearer' : mutant === 'wrong-scope' ? header.replace(/scope="[^"]+"/gu, 'scope="wrong"') : header };
  };
  const check = async (work: Promise<unknown>, error: unknown, expected: unknown) => {
    let got: unknown, failure: unknown;
    try { got = await work; } catch (err) { failure = err; }
    if (error !== undefined) {
      ok(failure instanceof AuthError, 'expected a typed authorization error');
      equal(failure.message, error);
    } else {
      if (failure instanceof AuthError) {
        throw new AssertionError({ message: `Expected authorization to succeed, got ${failure.message}` });
      }
      if (failure) throw failure;
      deepStrictEqual(got, expected);
    }
    assertions++;
  };
  for (const raw of script) {
    const step = record(raw);
    const discriminators = ['do', 'expect', 'server'].filter(key => Object.hasOwn(step, key));
    equal(discriminators.length, 1, 'expected one step discriminator');
    switch (`${discriminators[0]}:${String(step[discriminators[0]!])}`) {
      case 'do:challenge': {
        const action = step as Case;
        const signal = new AbortController().signal;
        await check(mutant === 'no-provider' ? Promise.resolve(false) : provider.onChallenge(statusFor(action), signal), action.error, action.retry ?? true);
        break;
      }
      case 'do:concurrent': {
        const first = new AbortController(), second = new AbortController();
        const a = mutant === 'no-provider' ? Promise.resolve(false) : provider.onChallenge(statusFor({}), first.signal);
        const b = provider.onChallenge(statusFor({}), second.signal);
        if (step['abortOne'] === true) first.abort();
        await Promise.all([check(a, step['abortOne'] ? 'auth-failure/cancelled' : step['error'], true), check(b, step['error'], true)]);
        break;
      }
      case 'do:advance':
        ok(typeof step['ms'] === 'number' && Number.isFinite(step['ms']));
        now += step['ms'];
        break;
      case 'server:update':
        if (step['prm'] !== undefined) prm = record(step['prm']);
        if (step['metadata'] !== undefined) metadata = record(step['metadata']);
        if (step['callback'] !== undefined) callbackConfig = record(step['callback']);
        break;
      case 'expect:header':
        await check(mutant === 'no-provider' ? Promise.resolve(undefined) : mutant === 'preemptive-bearer' ? Promise.resolve('Bearer unsolicited') :
          provider.headerFor(mutant === 'allow-cross-resource' ? resource : String(step['url'] ?? resource)).then(x => x?.authorization),
          step['error'], step['value'] ?? undefined);
        break;
      case 'expect:fetches': deepStrictEqual(fetches.map(r => `${r.method} ${r.url}`), step['values']); assertions++; break;
      case 'expect:form': fields(fetches.filter(r => r.method === 'POST')[Number(step['index'] ?? 0)]?.form, step['match']); assertions++; break;
      case 'expect:open': {
        const open = opens[Number(step['index'] ?? 0)];
        ok(open, 'no authorization URL opened');
        equal(`${open.origin}${open.pathname}`, step['url']);
        fields(Object.fromEntries(open.searchParams), step['match']);
        if (Array.isArray(step['absent'])) for (const key of step['absent']) equal(open.searchParams.has(String(key)), false);
        assertions++;
        break;
      }
      case 'expect:prompt': fields(prompts[Number(step['index'] ?? 0)], step['match']); assertions++; break;
      case 'expect:counts': fields({ open: opens.length, prompts: prompts.length, token: tokenNumber, fetch: fetches.length }, step['match']); assertions++; break;
      case 'expect:parse': deepStrictEqual(mutant === 'ignore-bearer-challenge' ? [] : parseBearerChallenges(step['input'] as string | string[]), step['value']); assertions++; break;
      case 'expect:canonical': equal(mutant === 'no-provider' ? step['input'] : canonicalResource(String(step['input']), step['preserveSlash'] === true), step['value']); assertions++; break;
      case 'expect:pkce': equal(mutant === 'bad-pkce' ? step['verifier'] : pkceChallenge(String(step['verifier'])), step['value']); assertions++; break;
      case 'expect:ssrf': {
        ok(typeof step['url'] === 'string' && typeof step['error'] === 'string');
        // A bypass mutant may not contact the blocked address, even in conformance tests.
        await check(mutant === 'no-ssrf-guard' ? Promise.resolve(new Response()) : new SafeFetch().fetch(step['url']), step['error'], undefined);
        break;
      }
      case 'expect:diagnostics': deepStrictEqual(diagnostics, step['values']); assertions++; break;
      case 'expect:store-writes': deepStrictEqual(writes, step['values']); assertions++; break;
      default: throw new Error(`unknown auth step: ${JSON.stringify(raw)}`);
    }
  }
  ok(assertions > 0, 'auth exchange has no assertions');
  return frames.length === 0 ? { frames: [], zeroWire: true } : { frames, mcpEndpoint: loopback(resource) };
}
