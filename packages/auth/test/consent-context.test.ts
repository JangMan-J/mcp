import { expect, it } from 'vitest';
import type { AuthRequestContext } from '@mcp-client/core';
import { startTestAuthorizationServer } from '../../fixtures/server/as-main.js';
import { ConfiguredBearer, OAuthAuthorization, SafeFetch } from '../src/index.js';

it('uses the host consent port for an informed decision before opening the browser', async () => {
  const redirectUri = 'https://client.example.test/callback';
  const as = await startTestAuthorizationServer(redirectUri);
  const auth = new OAuthAuthorization({
    resource: as.resource, redirectUri, allowInsecureDev: true,
    fetch: new SafeFetch({ allowInsecureDev: true, allowAddress: host => host === '127.0.0.1' }),
    registrations: { [as.issuer]: { clientId: 'test-client', redirectUris: [redirectUri] } },
    redirect: { async waitForCallback() { throw Error('callback must not start'); } },
    browser: { async open() { throw Error('browser must not open'); } },
  });
  try {
    const initial = await fetch(as.resource);
    const challenge = { status: 401 as const, resource: as.resource, wwwAuthenticate: initial.headers.get('www-authenticate')! };
    const signal = new AbortController().signal;
    await expect(auth.onChallenge(challenge, signal)).rejects.toMatchObject({ kind: 'auth-unavailable', reason: 'authorize' });
    const decisions = ['decline', 'cancel'] as const;
    let prompts = 0;
    const context: AuthRequestContext = { signal, serverLabel: 'Example MCP', consent: {
      async request(prompt) {
        expect(prompt).toMatchObject({ kind: 'authorize', serverLabel: 'Example MCP', resource: as.resource,
          issuerHost: new URL(as.issuer).hostname, redirectHost: 'client.example.test' });
        expect(prompt.scopes).toBeInstanceOf(Array);
        return { decision: decisions[prompts++]! };
      },
    } };
    for (const reason of ['declined', 'cancelled']) {
      await expect(auth.onChallenge(challenge, signal, context)).rejects.toMatchObject({ kind: 'auth-failure', reason });
    }
    expect(prompts).toBe(2);
    expect(as.calls.filter(x => x.method === 'POST' || x.path === '/authorize')).toEqual([]);
    expect(await auth.headerFor(as.resource)).toBeUndefined();
  } finally { await as.close(); }
});

it('does not refresh again when a late 401 refers to the already replaced credential', async () => {
  const resource = 'https://mcp.example.test/rpc';
  let refreshes = 0;
  const auth = new ConfiguredBearer({ resource, token: async () => `credential-${refreshes}`, refresh: async () => { refreshes++; } });
  const old = (await auth.headerFor(resource))!;
  const signal = new AbortController().signal;
  const challenge = { status: 401 as const, resource, credentialVersion: old.credentialVersion! };
  expect(await auth.onChallenge(challenge, signal)).toBe(true);
  expect((await auth.headerFor(resource))!.authorization).toBe('Bearer credential-1');
  expect(await auth.onChallenge(challenge, signal)).toBe(true);
  expect((await auth.headerFor(resource))!.authorization).toBe('Bearer credential-1');
});
