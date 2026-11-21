import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLiveAuth, inspectServerCard, type LegacyServerConfig } from './auth.js';
import { createIsolatedCredentialStore } from './credentials.js';

const http = (over: Partial<LegacyServerConfig> = {}): LegacyServerConfig => ({
  name: 's', source: 'global', trusted: true, transport: 'http', 
  url: 'https://mcp.example.test/mcp', ...over,
});

describe('pi-durable isolated credentials', () => {
  it('writes only inside the given state directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pid-auth-'));
    const store = createIsolatedCredentialStore(join(dir, 'creds'));
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    expect(await readdir(join(dir, 'creds'))).toEqual(['pi-mcp-client-credentials.json']);
    expect(JSON.parse(await readFile(join(dir, 'creds', 'pi-mcp-client-credentials.json'), 'utf8'))).toEqual({ k: 'v' });
  });

  it.each([
    [join(homedir(), '.pi', 'agent'), {}],
    [join(homedir(), '.pi'), {}],
    ['/x/agent/sub', { PI_CODING_AGENT_DIR: '/x/agent' }],
    ['/x/mcp-auth.json', {}],
  ])('rejects global Pi location %s', (dir, env) => {
    expect(() => createIsolatedCredentialStore(dir, env)).toThrow(/global Pi/u);
  });
});

describe('createLiveAuth', () => {
  it('matches live-auth selection with an isolated store', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'pid-auth-'));
    expect(await createLiveAuth(http({ transport: 'stdio', url: undefined }), { stateDir })).toEqual({});
    const oauth = await createLiveAuth(http(), { stateDir });
    expect(oauth.provider?.contextId()).toBe('anonymous');
    expect(typeof oauth.signIn).toBe('function');
    await oauth.close?.();
    const bearer = await createLiveAuth(http({ auth: { provider: 'p' } }), { stateDir, resolveProviderToken: async () => 'tok' });
    expect(bearer.provider).toBeDefined();
    const cc = await createLiveAuth(http({ clientCredentials: { clientId: 'c', credentialKey: 'ck' } }), { stateDir });
    expect(cc.provider).toBeDefined();
    await expect(createLiveAuth(http(), { stateDir: join(homedir(), '.pi', 'agent') })).rejects.toThrow(/global Pi/u);
  });
});

describe('inspectServerCard', () => {
  const card = { $schema: 'https://static.modelcontextprotocol.io/schemas/server-card.json', name: 'x/y', version: '1', description: 'd' };

  it('fetches the canonical card url without credentials', async () => {
    const seen: [string, RequestInit][] = [];
    const fetch = { fetch: async (url: string, init: RequestInit) => { seen.push([url, init]); return Response.json(card); } };
    const parsed = await inspectServerCard(http({ headers: { Authorization: 'x' } }), undefined, { fetch, headers: { authorization: 'Bearer t' } });
    expect(parsed?.card.name).toBe('x/y');
    expect(parsed?.inferredCapabilities).toEqual({});
    expect(seen[0]![0]).toBe('https://mcp.example.test/mcp/server-card');
    expect(JSON.stringify(seen[0]![1].headers)).not.toMatch(/authorization/iu);
  });

  it('skips untrusted or non-http servers and honours abort', async () => {
    const fetch = { fetch: async () => { throw new Error('unexpected'); } };
    expect(await inspectServerCard(http({ trusted: false }), undefined, { fetch })).toBeUndefined();
    expect(await inspectServerCard(http({ transport: 'stdio' }), undefined, { fetch })).toBeUndefined();
    await expect(inspectServerCard(http(), AbortSignal.abort(), { fetch })).rejects.toThrow();
  });
});
