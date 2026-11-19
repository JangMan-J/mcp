import { isDeepStrictEqual } from 'node:util';
import { AuthError, ConfiguredBearer, OAuthAuthorization, SafeFetch, type AuthorizationPrompt } from '@mcp-client/auth';
import { HttpTransport } from '@mcp-client/transport-http';
import type { ExchangeFixture } from '@mcp-client/fixtures';
import type { FixtureResult } from './run.js';

const mutants = new Map(Object.entries({
  '401-retry': 'reuse-wire-id', 'consent-decline': 'ignore-consent', 'consent-cancel': 'ignore-consent',
  'plain-403': 'force-step-up', 'step-up': 'drop-prior-scope', bearer: 'token-in-query',
}));
interface Peer {
  origin: string;
  posts: { id: unknown; method: unknown; authorization?: string; status: number; target: string }[];
  authorizeScopes: string[];
  paths: string[];
  check(): void;
  close(): Promise<void>;
}
class Mismatch extends Error {}
function check(condition: boolean, message: string) { if (!condition) throw new Mismatch(message); }

async function exercise(fixture: ExchangeFixture, scenario: string, peer: Peer, mutant?: string) {
  const resource = `${peer.origin}/mcp`, redirectUri = `${peer.origin}/callback`;
  const prompts: AuthorizationPrompt[] = [];
  let callback: ((p: URLSearchParams) => void) | undefined, portError: unknown;
  const decision = scenario === 'consent-cancel' ? 'cancel' : scenario === 'consent-decline' ? 'decline' : 'accept';
  const provider = scenario === 'bearer' ? new ConfiguredBearer({ resource, token: 'fixture-configured', allowInsecureDev: true }) : new OAuthAuthorization({
    resource, redirectUri, allowInsecureDev: true, flowTimeoutMs: 2500,
    fetch: new SafeFetch({ allowInsecureDev: true, allowAddress: host => host === '127.0.0.1' }),
    registrations: { [peer.origin]: { clientId: 'fixture-client', redirectUris: [redirectUri] } },
    consent: { async request(prompt) { prompts.push(prompt); return { decision: mutant === 'ignore-consent' ? 'accept' : decision }; } },
    redirect: { waitForCallback() { return new Promise(resolve => { callback = resolve; }); } },
    browser: { async open(input, signal) {
      try {
        const url = new URL(input);
        if (url.origin !== peer.origin.replace('http:', 'https:') || url.pathname !== '/authorize') throw Error('unexpected browser destination');
        url.protocol = 'http:'; // Translate only the synthetic browser's own loopback AS.
        if (mutant === 'drop-prior-scope' && prompts.length === 2) url.searchParams.set('scope', 'write');
        const response = await fetch(url, { redirect: 'manual', signal });
        const target = new URL(response.headers.get('location') ?? '');
        if (response.status !== 302 || target.origin + target.pathname !== redirectUri || !callback) throw Error('bad AS redirect');
        callback(target.searchParams);
      } catch (e) { portError = e; throw e; }
    } },
  });
  const rejections: string[] = [];
  const transport = new HttpTransport({ url: resource, authProvider: {
    headerFor: url => provider.headerFor(url), contextId: () => provider.contextId(),
    async onChallenge(challenge, signal) {
      try { return await provider.onChallenge(challenge, signal); }
      catch (e) {
        // HttpTransport intentionally turns challenge errors into forbidden. Do not
        // mistake a broken AS or failed discovery for a consent rejection.
        if (e instanceof AuthError && ['cancelled', 'declined'].includes(e.reason) && !signal.aborted) rejections.push(e.reason);
        else portError = e;
        throw e;
      }
    },
  }, fetchPort: { async fetch(input, init) {
    if (input !== resource) throw Error('unexpected resource URL');
    if (mutant === 'reuse-wire-id' && peer.posts.length === 1) init = { ...init, body: JSON.stringify({ ...JSON.parse(String(init.body)), id: peer.posts[0]!.id }) };
    if (mutant === 'token-in-query') input += '?access_token=fixture-configured';
    const response = await fetch(input, init);
    if (mutant === 'force-step-up' && response.status === 403) return new Response(response.body, { status: 403, headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' } });
    return response;
  } } });
  const wire = fixture.expect.wire as (NonNullable<ExchangeFixture['expect']['wire']> & { statuses: number[]; authorizeScopes: string[] }) | undefined;
  if (!wire || !Array.isArray(wire.statuses) || !Array.isArray(wire.authorizeScopes) || !fixture.script.length) throw Error('invalid binding fixture');
  const ends = [];
  for (const step of fixture.script) {
    if (!('do' in step) || step.do !== 'call') throw Error('unsupported binding step');
    const end = await transport.start({ jsonrpc: '2.0', id: step.as, method: step.method, params: step.params ?? {} }, {
      idempotent: false, signal: AbortSignal.timeout(3000), timeoutMs: 3000,
    }).done;
    peer.check();
    if (portError) throw portError;
    if (end.kind === 'failure' && end.failure.kind !== 'forbidden') throw Error(`transport failed: ${end.failure.kind}`);
    ends.push({ end, id: step.as });
  }
  check(isDeepStrictEqual(peer.posts.map(p => p.status), wire.statuses), 'unexpected MCP rejection/retry sequence');
  check(peer.posts.length === wire.totalRequests, 'unexpected request count');
  check(peer.posts.every(p => p.target === '/mcp' && p.method === 'tools/call'), 'unexpected request target or method');
  if (wire.distinctIds) check(new Set(peer.posts.map(p => p.id)).size === peer.posts.length, 'duplicate wire ID');
  check(isDeepStrictEqual(peer.authorizeScopes, wire.authorizeScopes), 'unexpected scopes at authorization endpoint');
  check(isDeepStrictEqual(rejections, decision === 'cancel' ? ['cancelled'] : decision === 'decline' ? ['declined'] : []), 'unexpected consent rejection');
  const scopes = prompts.map(p => p.kind === 'authorize' && p.resource === resource ? p.scopes.join(' ') : null);
  check(isDeepStrictEqual(scopes, decision === 'accept' ? wire.authorizeScopes : ['read']), 'unexpected consent prompt');
  check(peer.paths.filter(p => p === '/token').length === wire.authorizeScopes.length, 'unexpected token exchange');
  if (scenario === 'bearer' || scenario === 'plain-403') check(peer.paths.every(p => p === '/mcp'), 'unexpected discovery');
  const expectedHeaders = scenario === 'bearer' ? ['Bearer fixture-configured', 'Bearer fixture-configured'] :
    scenario === 'step-up' ? [undefined, 'Bearer fixture-token-1', 'Bearer fixture-token-1', 'Bearer fixture-token-2'] :
    scenario === '401-retry' ? [undefined, 'Bearer fixture-token-1'] : [undefined];
  check(isDeepStrictEqual(peer.posts.map(p => p.authorization), expectedHeaders), 'incorrect bearer on MCP POST');
  for (const [i, { end, id }] of ends.entries()) {
    if (decision !== 'accept' || scenario === 'plain-403') {
      check(end.kind === 'failure' && end.failure.kind === 'forbidden' && end.failure.status === (scenario === 'plain-403' ? 403 : 401) && end.delivery === 'not-sent', 'rejection was not definitive');
    } else {
      check(end.kind === 'response' && end.message.id === id && 'result' in end.message && isDeepStrictEqual(end.message.result, { resultType: 'complete', write: i + 1 }), 'write result not mapped to original call');
    }
  }
}

export async function runTierBAuthFixture(fixture: ExchangeFixture, mutant?: string): Promise<(FixtureResult & { failure?: 'assertion' }) | undefined> {
  const prefix = 'auth/http-binding-';
  if (fixture.tier !== 'B' || !fixture.id.startsWith(prefix)) return undefined;
  const scenario = fixture.id.slice(prefix.length), result = { id: fixture.id, ...(mutant !== undefined ? { mutant } : {}) };
  try {
    if (!mutants.has(scenario) || fixture.binding !== 'http') throw Error('unsupported auth binding fixture');
    if (mutant !== undefined && mutant !== mutants.get(scenario)) throw Error('unsupported auth binding mutant');
    // The fixture-only listener is not part of a published package or its build.
    const helper = new URL('../../fixtures/server/auth-binding-main.ts', import.meta.url);
    const { startBindingPeer } = await import(helper.href) as { startBindingPeer(scenario: string): Promise<Peer> };
    const peer = await startBindingPeer(scenario);
    try { await exercise(fixture, scenario, peer, mutant); } finally { await peer.close(); }
    return { ...result, ok: true };
  } catch (e) {
    return { ...result, ok: false, ...(e instanceof Mismatch ? { failure: 'assertion' as const } : {}), error: e instanceof Error ? e.message : String(e) };
  }
}
