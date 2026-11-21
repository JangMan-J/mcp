import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { McpClient } from '@mcp-client/core';
import { StatefulClient, elicitationExtension } from '@mcp-client/mrtr-cache';
import { ToolsApi } from '@mcp-client/ops';
import { StdioTransport } from '@mcp-client/transport-stdio';

const dir = await mkdtemp(join(tmpdir(), 'pi-trial-'));
const log = join(dir, 'main.log');
const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const summary = {};
const consent = {
  serverLabel: 'trial',
  port: { url: async ({ url }) => { summary.consentUrl = url; return 'accept'; } },
  browser: { open: async () => {} }, // This synthetic trial must not open the URL.
};
async function run(mode, check) {
  const transport = new StdioTransport({ command: process.execPath,
    args: [server, '--mode', mode, ...(mode === 'main' ? ['--log', log] : [])] });
  const client = new McpClient({ transport, server: { key: mode },
    defaults: { timeoutMs: 8000 }, extensions: [elicitationExtension(consent)] });
  try {
    const stateful = new StatefulClient({ ...consent, serverRef: mode, request: client.request.bind(client) });
    const discover = await client.discover();
    assert.equal(discover.kind, 'ok', JSON.stringify(discover));
    assert.ok(discover.value.supportedVersions.includes('2026-07-28'));
    await check(new ToolsApi(stateful, { capabilities: () => discover.value.capabilities }));
  } finally { await client.close(); }
}
async function waitForMethod(method, count = 1) {
  const until = Date.now() + 5000;
  do {
    const methods = (await readFile(log, 'utf8')).split('\n');
    if (methods.filter(m => m === method).length >= count) return;
    await sleep(10);
  } while (Date.now() < until);
  assert.fail(`Server did not receive ${method} ${count} time(s)`);
}
function ok(outcome) {
  assert.equal(outcome.kind, 'ok', JSON.stringify(outcome));
  return outcome.value;
}
try {
  await run('main', async tools => {
    summary.discover = 'ok';
    summary.tools = ok(await tools.list()).tools.map(t => t.name).sort();
    assert.deepEqual(summary.tools, ['echo', 'needs_consent', 'secret_lookup', 'slow']);
    summary.echo = ok(await tools.call('echo', { text: 'hi' })).raw.content[0].text;
    assert.equal(summary.echo, 'echo: hi');

    const ctrl = new AbortController();
    // Unlike write_record, this fixture's sleep has no side effects.
    const slow = tools.call('slow', {}, { signal: ctrl.signal, idempotent: true });
    try { await waitForMethod('tools/call', 2); } finally { ctrl.abort(); }
    summary.slow = (await slow).kind;
    assert.equal(summary.slow, 'cancelled');
    await waitForMethod('notifications/cancelled');

    summary.consent = ok(await tools.call('needs_consent', {})).raw.content[0].text;
    assert.equal(summary.consent, 'consent accepted');
    assert.equal(summary.consentUrl, 'https://consent.example.test/approve?id=1');
  });
  await run('crash', async tools => {
    summary.write = (await tools.call('write_record', { value: 'trial' })).kind;
    assert.equal(summary.write, 'uncertain-write');
  });
  console.log(JSON.stringify(summary));
} finally { await rm(dir, { recursive: true, force: true }); }
