// openRuntime against a real legacy (pre-server/discover) stdio server spawned with node -e.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpOutcomeError } from '@mcp-client/core';
import { StdioTransport } from '@mcp-client/transport-stdio';
import { APPS_EXTENSION_ID, MCP_APP_MIME_TYPE, type AppViewPayload } from '@mcp-client/ext-apps';
import { openRuntime, type DurableRuntime, type RuntimeOptions } from './runtime.js';

// Legacy server: no server/discover, no resultType on any result.
const LEGACY = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let init, initialized = false;
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
const tools = [{ name: 'probe', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://legacy/view' } } }];
rl.on('line', line => {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === 'notifications/initialized') { initialized = true; return; }
  if (id === undefined) return;
  const ok = result => send({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize': init = params; return ok({ protocolVersion: '2025-11-25', serverInfo: { name: 'legacy', version: '0' }, capabilities: { tools: {}, resources: {} } });
    case 'tools/list': return ok({ tools });
    case 'tools/call': return ok({ content: [{ type: 'text', text: JSON.stringify({ secret: process.env.PID_SECRET ?? null, init, initialized }) }] });
    case 'resources/read': return ok({ contents: [{ uri: params.uri, mimeType: '${MCP_APP_MIME_TYPE}', text: '<p>app</p>' }] });
    default: send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
  }
});`;

const server = (extra: Record<string, unknown> = {}) => ({ name: 'legacy', command: process.execPath, args: ['-e', LEGACY], ...extra });
let stateDir: string;
const open: DurableRuntime[] = [];
const start = async (input: { name: string; [k: string]: unknown }, opts: RuntimeOptions = {}) => {
  const rt = await openRuntime(input, { stateDir, ...opts });
  open.push(rt);
  return rt;
};
const probe = async (rt: DurableRuntime) => {
  const r = await rt.callTool({ serverId: 'legacy', toolName: 'probe', args: {}, requestId: 'r1' } as never);
  return JSON.parse((r.content[0] as { text: string }).text) as { secret: string | null; init: { capabilities: Record<string, unknown> }; initialized: boolean };
};

beforeEach(async () => { stateDir = await mkdtemp(join(tmpdir(), 'pid-runtime-')); process.env.PID_SECRET = 'leak'; });
afterEach(async () => {
  await Promise.all(open.splice(0).map(rt => rt.close()));
  delete process.env.PID_SECRET;
  await rm(stateDir, { recursive: true, force: true });
});

describe('openRuntime legacy initialize', () => {
  it('is off by default: discovery surfaces method-not-found', async () => {
    const rt = await start(server());
    expect(await rt.ready()).toMatchObject({ kind: 'jsonrpc-error', code: -32601 });
    await expect(rt.listTools()).rejects.toBeInstanceOf(McpOutcomeError);
  });

  it('opt-in on stdio initializes, then lists and calls with legacy results', async () => {
    const rt = await start(server({ allowLegacyInitialize: true }));
    expect(await rt.ready()).toMatchObject({ kind: 'ok', value: { supportedVersions: ['2025-11-25'] } });
    expect(rt.capabilities).toEqual({ tools: {}, resources: {} });
    expect((await rt.listTools()).map(t => t.name)).toEqual(['probe']);
    const out = await probe(rt);
    expect(out.initialized).toBe(true);
    expect(out.init.capabilities).toEqual({});
  });

  it('runtime option enables legacy too, but never for http descriptors', async () => {
    const rt = await start(server(), { allowLegacyInitialize: true });
    expect((await rt.ready()).kind).toBe('ok');
    // Same legacy stdio process behind an http descriptor: fallback must not fire.
    const http = await start({ name: 'legacy', url: 'http://127.0.0.1:1/mcp', allowLegacyInitialize: true }, {
      createTransport: () => new StdioTransport({ command: process.execPath, args: ['-e', LEGACY] }),
    });
    expect(await http.ready()).toMatchObject({ kind: 'jsonrpc-error', code: -32601 });
  });

  it('isolates the child env unless inheritEnv allows a key', async () => {
    const isolated = await start(server({ allowLegacyInitialize: true }));
    expect((await probe(isolated)).secret).toBeNull();
    const allowed = await start(server({ allowLegacyInitialize: true, inheritEnv: ['PATH', 'PID_SECRET'] }));
    expect((await probe(allowed)).secret).toBe('leak');
    const viaOpts = await start(server({ allowLegacyInitialize: true }), { inheritEnv: true });
    expect((await probe(viaOpts)).secret).toBe('leak');
  });
});

describe('openRuntime apps', () => {
  it('without appRenderer: no extension advertised, no apps client', async () => {
    const rt = await start(server({ allowLegacyInitialize: true }));
    expect(rt.apps).toBeUndefined();
    const [tool] = await rt.listTools();
    expect(await rt.renderToolApp(tool!)).toBeUndefined();
    expect((await probe(rt)).init.capabilities).not.toHaveProperty(['extensions', APPS_EXTENSION_ID]);
  });

  it('with appRenderer: advertises apps and renders the tool UI resource', async () => {
    const views: AppViewPayload[] = [];
    const rt = await start(server({ allowLegacyInitialize: true }), { appRenderer: { render: v => { views.push(v); } } });
    expect(rt.apps).toBeDefined();
    const [tool] = await rt.listTools();
    const out = await rt.renderToolApp(tool!);
    expect(out).toMatchObject({ kind: 'ok', value: { resourceUri: 'ui://legacy/view', mimeType: MCP_APP_MIME_TYPE, text: '<p>app</p>', toolName: 'probe' } });
    expect(views).toHaveLength(1);
    expect((await probe(rt)).init.capabilities).toEqual({ extensions: { [APPS_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } } });
  });
});

describe('openRuntime stateDir', () => {
  it('without stateDir uses a temp dir removed on close', async () => {
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = stateDir;
    try {
      const rt = await openRuntime(server());
      expect((await readdir(stateDir)).filter(n => n.startsWith('pi-durable-'))).toHaveLength(1);
      await rt.close();
      expect(await readdir(stateDir)).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    }
  });
});
