import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error untyped .mjs fixture
import { startFixture } from '../../scripts/pi-trial/live-ext-fixture.mjs';
import type { LegacyServerConfig as PiConfig } from '../pi-coding-agent/config.js';
import { createLiveAuth, type LegacyServerConfig } from './auth.js';

// Structural check: a parsed pi-coding-agent descriptor is accepted as-is.
const accepts = (c: PiConfig): LegacyServerConfig => c;
void accepts;

let fx: { base: string; mcpUrl: string; close(): Promise<void> };
let stateDir: string;
beforeEach(async () => {
  fx = await startFixture();
  stateDir = await mkdtemp(join(tmpdir(), 'pid-auth-live-'));
});
afterEach(() => fx.close());

const descriptor = (): LegacyServerConfig => ({
  name: 'fixture', source: 'project', trusted: true, transport: 'http', url: fx.mcpUrl, oauth: { clientRegistration: 'dcr' },
});
// Isolated browser: follows the fixture's auto-approving /authorize redirect into the loopback callback.
const browser = { async open(url: string, signal: AbortSignal) { await (await fetch(url, { signal })).body?.cancel(); } };
const accept = { request: async () => ({ decision: 'accept' as const }) };

describe('pi-durable live OAuth against live-ext-fixture', () => {
  it('signs in and yields an audience-bound header accepted by the server', async () => {
    const auth = await createLiveAuth(descriptor(), { stateDir, browser, authorizationConsent: accept });
    expect(await auth.provider!.headerFor(fx.mcpUrl, 'request')).toBeUndefined();
    await auth.signIn!(AbortSignal.timeout(10_000));
    const header = await auth.provider!.headerFor(fx.mcpUrl, 'request');
    expect(header?.authorization).toMatch(/^Bearer [0-9a-f]+$/u);
    expect(auth.provider!.contextId()).not.toBe('anonymous');
    const res = await fetch(fx.mcpUrl, { method: 'POST', headers: { authorization: header!.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }) });
    expect(res.status).toBe(200);
    // No credential leak to other origins.
    expect(await auth.provider!.headerFor('https://evil.example/mcp', 'request')).toBeUndefined();
    expect(await readdir(stateDir)).toEqual(['pi-mcp-client-credentials.json']);
    await auth.close!();
    expect(await auth.provider!.headerFor(fx.mcpUrl, 'request')).toBeUndefined();
  });

  it('abort during a pending consent rejects promptly and leaves the provider anonymous', async () => {
    let asked!: () => void;
    const prompted = new Promise<void>(resolve => { asked = resolve; });
    const hang = { request: () => { asked(); return new Promise<never>(() => {}); } };
    const auth = await createLiveAuth(descriptor(), { stateDir, browser, authorizationConsent: hang });
    const ctl = new AbortController();
    const pending = auth.signIn!(ctl.signal);
    await prompted;
    ctl.abort(new Error('user-abort'));
    await expect(pending).rejects.toThrow();
    expect(auth.provider!.contextId()).toBe('anonymous');
    expect(await auth.provider!.headerFor(fx.mcpUrl, 'request')).toBeUndefined();
    await auth.close!();
  });
});
