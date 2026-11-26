import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { parseRedirectServerArgs, runRedirectServer } from '../src/index.js';

function hit(port: number, target: string, host: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', path: target, headers: { host } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Harness {
  readonly lines: Record<string, unknown>[];
  readonly port: number;
  readonly done: Promise<number>;
  readonly controller: AbortController;
}

/** Start the CLI in-process and hand back the parsed NDJSON it wrote so far. */
async function start(argv: readonly string[], stop: 'signal' | 'once' = 'signal'): Promise<Harness> {
  const lines: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const stderr: string[] = [];
  const done = runRedirectServer(argv, {
    stdout: line => { lines.push(JSON.parse(line) as Record<string, unknown>); },
    stderr: line => { stderr.push(line); },
    ...(stop === 'signal' ? { signal: controller.signal } : {}),
  });
  const listening = await vi.waitFor(() => {
    const header = lines.find(line => line.event === 'listening');
    if (!header) throw new Error(`no listening line yet: ${JSON.stringify({ lines, stderr })}`);
    return header;
  });
  return { lines, port: Number(new URL(String(listening.address)).port), done, controller };
}

it('reports the URI to publish and relays each callback as one JSON line', async () => {
  const harness = await start(['--redirect-uri', 'https://callbacks.test/oauth/callback']);
  try {
    expect(harness.lines[0]).toMatchObject({
      event: 'listening',
      redirectUri: 'https://callbacks.test/oauth/callback',
      pid: process.pid,
    });
    const response = await hit(harness.port, '/oauth/callback?code=abc&state=s1&iss=https%3A%2F%2Fas.test', 'callbacks.test');
    expect(response.status).toBe(200);
    const relayed = await vi.waitFor(() => {
      const found = harness.lines.find(line => line.event === 'callback');
      if (!found) throw new Error('no callback line yet');
      return found;
    });
    expect(relayed).toMatchObject({
      event: 'callback',
      state: 's1',
      params: { code: 'abc', state: 's1', iss: 'https://as.test' },
    });
    // Callbacks it did not solicit are relayed too — that is the point of a standalone server.
    await hit(harness.port, '/oauth/callback?code=def&state=s2', 'callbacks.test');
    await vi.waitFor(() => expect(harness.lines.filter(line => line.event === 'callback')).toHaveLength(2));
  } finally {
    harness.controller.abort();
  }
  expect(await harness.done).toBe(0);
  expect(harness.lines.at(-1)).toMatchObject({ event: 'closed', callbacks: 2 });
});

it('still refuses the wrong host or path', async () => {
  const harness = await start(['--redirect-uri', 'https://callbacks.test/oauth/callback']);
  try {
    expect((await hit(harness.port, '/oauth/callback?code=abc&state=s1', 'evil.test')).status).toBe(404);
    expect((await hit(harness.port, '/other?code=abc&state=s1', 'callbacks.test')).status).toBe(404);
    expect(harness.lines.some(line => line.event === 'callback')).toBe(false);
  } finally {
    harness.controller.abort();
  }
  await harness.done;
});

it('exits after the first callback with --once and can pin the expected state', async () => {
  const harness = await start(
    ['--redirect-uri', 'https://callbacks.test/cb', '--once', '--state', 'wanted'],
    'once',
  );
  await hit(harness.port, '/cb?code=ignored&state=other', 'callbacks.test');
  await vi.waitFor(() => expect(harness.lines.some(line => line.event === 'rejected')).toBe(true));
  await hit(harness.port, '/cb?code=kept&state=wanted', 'callbacks.test');
  expect(await harness.done).toBe(0);
  expect(harness.lines.filter(line => line.event === 'callback')).toEqual([
    expect.objectContaining({ state: 'wanted', params: { code: 'kept', state: 'wanted' } }),
  ]);
  expect(harness.lines.at(-1)).toMatchObject({ event: 'closed', callbacks: 1 });
});

it('serves TLS itself from --tls-key/--tls-cert files', async () => {
  const harness = await start([
    '--redirect-uri', 'https://callbacks.test/cb',
    '--tls-key', fileURLToPath(new URL('../../auth/test/fixtures/loopback-test-key.pem', import.meta.url)),
    '--tls-cert', fileURLToPath(new URL('../../auth/test/fixtures/loopback-test-cert.pem', import.meta.url)),
  ]);
  try {
    expect(String(harness.lines[0]!.address).startsWith('https://')).toBe(true);
  } finally {
    harness.controller.abort();
  }
  await harness.done;
});

it('rejects bad usage with exit code 2 and prints help for -h', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
  expect(await runRedirectServer([], io)).toBe(2);
  expect(err.join('\n')).toContain('--redirect-uri is required');
  expect(err.join('\n')).toContain('Usage: mcp-callback');
  expect(await runRedirectServer(['--redirect-uri', 'https://x.test/cb', '--nope'], io)).toBe(2);
  expect(await runRedirectServer(['--redirect-uri', 'https://x.test/cb', '--port', 'eighty'], io)).toBe(2);
  expect(await runRedirectServer(['--redirect-uri', 'https://x.test/cb', '--tls-key', 'only-key'], io)).toBe(2);
  expect(await runRedirectServer(['-h'], io)).toBe(0);
  expect(out.join('\n')).toContain('--redirect-uri <url>');
});

it('parses flags into server options', () => {
  expect(parseRedirectServerArgs([
    '--redirect-uri', 'https://x.test/cb',
    '--host', '0.0.0.0', '--port', '8710',
    '--allowed-host', 'proxy.test', '--trust-proxy',
    '--timeout-ms', '0', '--max-pending', '2',
    '--state', 'abc', '--once', '--allow-insecure-dev',
  ])).toEqual({
    redirectUri: 'https://x.test/cb',
    host: '0.0.0.0',
    port: 8710,
    allowedHosts: ['proxy.test'],
    timeoutMs: 2_147_483_647,
    maxPending: 2,
    trustProxy: true,
    allowInsecureDev: true,
    expectedState: 'abc',
    once: true,
  });
  expect(parseRedirectServerArgs(['--redirect-uri', 'http://127.0.0.1:1/cb', '--allow-insecure-dev']))
    .toMatchObject({ redirectUri: 'http://127.0.0.1:1/cb', allowInsecureDev: true });
});
