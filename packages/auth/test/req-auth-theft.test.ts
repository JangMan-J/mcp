import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import type { FetchPort } from '@mcp/core';
import { MemoryCredentialStore, OAuthAuthorization } from '../src/index.js';

// Wrap every Node write entry point so any write during the flow is recorded.
const writes = vi.hoisted(() => [] as string[]);
function wrap<T extends Record<string, unknown>>(real: T, names: string[], tag: string): T {
  const out: Record<string, unknown> = { ...real };
  for (const name of names) {
    const fn = real[name];
    if (typeof fn !== 'function') continue;
    out[name] = (...args: unknown[]) => { writes.push(`${tag}.${name}`); return (fn as (...a: unknown[]) => unknown)(...args); };
  }
  return out as T;
}
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const mod = wrap(real, ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'open', 'openSync',
    'write', 'writeSync', 'writev', 'writevSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'rename', 'renameSync', 'mkdir', 'mkdirSync'], 'fs');
  return { ...mod, default: mod };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const mod = wrap(real, ['writeFile', 'appendFile', 'open', 'copyFile', 'cp', 'rename', 'mkdir'], 'fs/promises');
  return { ...mod, default: mod };
});

afterEach(() => { writes.length = 0; vi.restoreAllMocks(); });

const RESOURCE = 'https://mcp.test/mcp';
const ISSUER = 'https://as.test';
const REDIRECT = 'https://client.test/callback';
const PRM = 'https://mcp.test/.well-known/oauth-protected-resource/mcp';

function harness() {
  let issued = 0;
  const tokenForms: Record<string, string>[] = [];
  const fetch: FetchPort = { async fetch(url, request) {
    if (url === PRM) return Response.json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['read'] });
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`)
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
        code_challenge_methods_supported: ['S256'] });
    if (url === `${ISSUER}/token` && request.method === 'POST') {
      tokenForms.push(Object.fromEntries(new URLSearchParams(String(request.body))));
      issued++;
      return Response.json({ token_type: 'Bearer', access_token: `secret-access-${issued}`, refresh_token: `secret-refresh-${issued}`, expires_in: 3600 });
    }
    return new Response('{}', { status: 404 });
  } };
  let opened: (url: URL) => void;
  const openedUrl = new Promise<URL>((resolve) => { opened = resolve; });
  const opens: string[] = [];
  const auth = new OAuthAuthorization({
    resource: RESOURCE, redirectUri: REDIRECT, fetch,
    registrations: { [ISSUER]: { clientId: 'client-1', redirectUris: [REDIRECT] } },
    consent: { async request() { return { decision: 'accept' }; } },
    browser: { async open(url) { opens.push(url); opened(new URL(url)); } },
    redirect: { async waitForCallback() {
      const url = await openedUrl;
      return new URLSearchParams({ code: 'code-1', state: url.searchParams.get('state')!, iss: ISSUER });
    } },
  });
  const challenge = () => auth.onChallenge({ status: 401, resource: RESOURCE,
    wwwAuthenticate: `Bearer resource_metadata="${PRM}"` }, new AbortController().signal);
  return { auth, challenge, opens, tokenForms };
}

it('[AUTH-THEFT-1] a full OAuth flow keeps tokens in the default in-memory store and writes nothing to disk', async () => {
  const set = vi.spyOn(MemoryCredentialStore.prototype, 'set');
  const first = harness();
  expect(await first.challenge()).toBe(true);
  expect(first.opens).toHaveLength(1);
  expect((await first.auth.headerFor(RESOURCE))?.authorization).toBe('Bearer secret-access-1');
  // No credential store was configured, so the default MemoryCredentialStore received the refresh token.
  expect(set.mock.calls.some(([, value]) => value === 'secret-refresh-1')).toBe(true);
  expect(writes).toEqual([]);

  // A fresh provider (as after a restart) finds no persisted refresh token and must run the browser flow again.
  const second = harness();
  expect(await second.challenge()).toBe(true);
  expect(second.opens).toHaveLength(1);
  expect(second.tokenForms.map((f) => f['grant_type'])).toEqual(['authorization_code']);
  expect(writes).toEqual([]);
});

it('[AUTH-THEFT-1] the write spies record writes (self-check)', async () => {
  const fs = await import('node:fs');
  const fsp = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = `${tmpdir()}/req-auth-theft-${process.pid}.txt`;
  fs.writeFileSync(path, 'x');
  await fsp.appendFile(path, 'y');
  fs.rmSync(path);
  expect(writes).toEqual(['fs.writeFileSync', 'fs/promises.appendFile']);
});

const SRC = new URL('../src/', import.meta.url);
const FS_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?fs(?:\/promises)?['"]/u;
const WRITE_API = /\b(?:writeFile|appendFile|createWriteStream|writeSync|openSync|copyFile|rename|mkdir)\w*\s*\(/u;
function offenders(files: Record<string, string>) {
  return Object.entries(files).filter(([, text]) => FS_IMPORT.test(text) || WRITE_API.test(text)).map(([name]) => name);
}

it('[AUTH-THEFT-1] packages/auth/src imports no fs module and calls no fs write API', () => {
  const files = Object.fromEntries(readdirSync(SRC).filter((f) => f.endsWith('.ts'))
    .map((f) => [f, readFileSync(new URL(f, SRC), 'utf8')]));
  expect(Object.keys(files)).toContain('provider.ts');
  expect(offenders(files)).toEqual([]);
});

it('[AUTH-THEFT-1] the static scan flags fs imports and write calls (self-check)', () => {
  expect(offenders({
    a: "import { writeFileSync } from 'node:fs';",
    b: "import fs from 'fs/promises';",
    c: "await import('node:fs')",
    d: 'store.appendFile(path, token);',
    e: "import { randomBytes } from 'node:crypto';",
  })).toEqual(['a', 'b', 'c', 'd']);
});
