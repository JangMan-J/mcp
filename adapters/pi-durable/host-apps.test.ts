import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_APP_MIME_TYPE } from '@mcp-client/ext-apps';
import { startDurableMcpHost, type DurableMcpHost } from './host.js';

let dir: string;
let log: string;
let host: DurableMcpHost | undefined;

const fixture = (logPath: string) => `
const rl = require('node:readline').createInterface({ input: process.stdin });
const fs = require('node:fs');
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const tools = [
  { name: 'write', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://legacy/view' } } },
  { name: 'plain', inputSchema: { type: 'object' } },
];
rl.on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'notifications/initialized' || id === undefined) return;
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ method, params }) + '\\n');
  const ok = result => send({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': return ok({ protocolVersion: '2025-11-25', serverInfo: { name: 'legacy', version: '0' }, capabilities: { tools: {}, resources: {} } });
    case 'tools/list': return ok({ tools });
    case 'tools/call': return ok({ content: [{ type: 'text', text: 'called ' + params.name }] });
    case 'resources/read': return ok({ contents: [{ uri: params.uri, mimeType: '${MCP_APP_MIME_TYPE}', text: '<p>app</p>' }] });
    default: send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }
});`;

const calls = async () => {
  try {
    return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { method: string });
  } catch { return []; }
};
const start = async (appRenderer?: { render(): void }) => {
  host = await startDurableMcpHost({
    servers: [{ name: 'legacy', command: process.execPath, args: ['-e', fixture(log)], allowLegacyInitialize: true }],
    ...(appRenderer ? { appRenderer } : {}),
  });
  return host;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-durable-host-apps-'));
  log = join(dir, 'calls.jsonl');
});
afterEach(async () => {
  await host?.close();
  host = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('durable host MCP Apps', () => {
  it('returns and commits the tool result when app rendering fails, without resending on replay', async () => {
    const h = await start({ render() { throw new Error('renderer failed'); } });
    const first = await h.call('app-call', 'mcp__legacy__write', {});
    const replay = await h.call('app-call', 'mcp__legacy__write', {});
    expect(first).toMatchObject({ output: [{ type: 'text', text: 'called write' }] });
    expect(replay).toEqual(first);
    expect((await calls()).filter(c => c.method === 'tools/call')).toHaveLength(1);
    expect((await calls()).filter(c => c.method === 'resources/read')).toHaveLength(1);
  });

  it('does not load an app for tools without app metadata or without a renderer', async () => {
    const h = await start({ render() { throw new Error('must not render'); } });
    await h.call('plain-call', 'mcp__legacy__plain', {});
    expect((await calls()).filter(c => c.method === 'resources/read')).toHaveLength(0);
    await h.close();

    log = join(dir, 'without-renderer.jsonl');
    const without = await start();
    await without.call('write-call', 'mcp__legacy__write', {});
    expect((await calls()).filter(c => c.method === 'resources/read')).toHaveLength(0);
  });
});
