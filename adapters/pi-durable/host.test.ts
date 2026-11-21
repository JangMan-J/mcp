// Integration tests for startDurableMcpHost against real stdio and Streamable HTTP
// fixture servers (./host-fixture.mjs) and a real SQLite database file.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { argsDigest } from './adapter.js';
import { CALL_TOOL_RESULT_SCHEMA, INTERRUPTED_OUTPUT } from './extension.js';
import { startDurableMcpHost } from './host.js';
// @ts-expect-error untyped .mjs fixture
import { PNG, startHttpFixture } from './host-fixture.mjs';

const FIXTURE = fileURLToPath(new URL('./host-fixture.mjs', import.meta.url));
type Host = Awaited<ReturnType<typeof startDurableMcpHost>>;
type Block = { type: string; text?: string; data?: string; mimeType?: string };
type Result = { output: Block[]; isError?: boolean; structuredOutput?: any; details?: any };

let dir: string;
let databasePath: string;
let log: string;
const open: Host[] = [];
const closers: (() => Promise<void>)[] = [];

const stdioServer = (name = 'stdio') => ({ name, command: process.execPath, args: [FIXTURE, log] });
async function start(options: Record<string, unknown>): Promise<Host> {
  const host = await startDurableMcpHost({ databasePath, ...options } as never);
  open.push(host);
  return host;
}
const stdioCalls = (): { name: string; arguments: unknown }[] =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const call = (host: Host, key: string, name: string, args: Record<string, unknown> = {}) =>
  host.call(key, name, args) as Promise<Result>;
const text = (r: Result) => r.output.filter(b => b.type === 'text').map(b => b.text).join('\n');
const allTools = (host: Host) => host.extensions.flatMap(e => e.tools ?? []);
const feature = (host: Host, suffix: string) => {
  const t = allTools(host).find(t => t.name === suffix || t.name.endsWith(`__${suffix}`) || t.name.endsWith(`_${suffix}`));
  if (!t) throw new Error(`no ${suffix} tool among ${allTools(host).map(t => t.name).join(', ')}`);
  return t;
};
const api = (callId: string) => ({ callId, executeTool: async () => { throw new Error('no nesting'); } });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pi-durable-host-'));
  databasePath = join(dir, 'durable.db');
  log = join(dir, 'stdio-calls.jsonl');
});
afterEach(async () => {
  await Promise.allSettled(open.splice(0).map(h => h.close()));
  await Promise.allSettled(closers.splice(0).map(c => c()));
  rmSync(dir, { recursive: true, force: true });
});

describe('startDurableMcpHost: stdio', () => {
  it('registers real durable tools with prefixed names, schema and callers', async () => {
    const host = await start({ servers: [stdioServer()] });
    expect(host.toolNames).toEqual(expect.arrayContaining(['mcp__stdio__echo', 'mcp__stdio__write', 'mcp__stdio__image']));
    const echo = allTools(host).find(t => t.name === 'mcp__stdio__echo')!;
    expect(echo).toBeDefined();
    expect(echo.parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } } });
    expect(echo.structuredOutputSchema).toEqual(CALL_TOOL_RESULT_SCHEMA);
    expect(echo.replay).toBe('unsafe');
    expect(echo.callers).toEqual(['model', 'tools']);
    expect(typeof echo.cancel).toBe('function');
  });

  it('returns ContentBlock[] output and _meta-stripped structuredOutput', async () => {
    const host = await start({ servers: [stdioServer()] });
    const r = await call(host, 'k-echo', 'mcp__stdio__echo', { text: 'hi' });
    expect(r.output).toEqual([{ type: 'text', text: 'hi' }]);
    expect(r.isError).toBeFalsy();
    expect(r.structuredOutput.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(r.structuredOutput).not.toHaveProperty('_meta');

    const img = await call(host, 'k-img', 'mcp__stdio__image');
    expect(img.output).toEqual([{ type: 'text', text: 'pic' }, { type: 'image', data: PNG, mimeType: 'image/png' }]);

    const s = await call(host, 'k-struct', 'mcp__stdio__structured', { n: 21 });
    expect(s.structuredOutput.structuredContent).toEqual({ doubled: 42 });

    const f = await call(host, 'k-fail', 'mcp__stdio__fail');
    expect(f.isError).toBe(true);
    expect(text(f)).toContain('boom');
  });

  it('executes through the registered durable tool the same as host.call', async () => {
    const host = await start({ servers: [stdioServer()] });
    const echo = allTools(host).find(t => t.name === 'mcp__stdio__echo')!;
    const r = (await echo.execute({ text: 'via registry' }, api('reg-1') as never, {})) as unknown as Result;
    expect(r.output).toEqual([{ type: 'text', text: 'via registry' }]);
  });

  it('commits argsDigest, never raw args, for every direct call', async () => {
    const host = await start({ servers: [stdioServer()] });
    await call(host, 'k-digest', 'mcp__stdio__write', { v: 'secret-arg' });
    await host.close();
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT key, status, request_json FROM durable_calls').all() as { key: string; status: string; request_json: string }[];
      const row = rows.find(r => r.key.includes('k-digest'));
      expect(row?.status).toBe('completed');
      const intent = JSON.parse(row!.request_json);
      expect(intent).toMatchObject({ method: 'tools/call', server: 'stdio', name: 'write', digest: argsDigest({ v: 'secret-arg' }) });
      expect(row!.request_json).not.toContain('secret-arg');
    } finally { db.close(); }
  });

  it('replays a completed call across SQLite reopen without resending', async () => {
    const first = await start({ servers: [stdioServer()] });
    const a = await call(first, 'k-replay', 'mcp__stdio__write', { v: 'x' });
    expect(text(a)).toBe('wrote x #1');
    await first.close();
    expect(stdioCalls().filter(c => c.name === 'write')).toHaveLength(1);

    const second = await start({ servers: [stdioServer()] });
    const b = await call(second, 'k-replay', 'mcp__stdio__write', { v: 'x' });
    expect(b.output).toEqual(a.output);
    expect(stdioCalls().filter(c => c.name === 'write')).toHaveLength(1);
  });

  it('surfaces an interrupted write as uncertain-write after reopen and never resends it', async () => {
    const first = await start({ servers: [stdioServer()] });
    const pending = call(first, 'k-crash', 'mcp__stdio__hang').catch(e => e);
    await expect.poll(() => stdioCalls().some(c => c.name === 'hang'), { timeout: 5000 }).toBe(true);
    await first.close(); // intent committed, outcome never committed
    await pending;

    const second = await start({ servers: [stdioServer()] });
    const r = await call(second, 'k-crash', 'mcp__stdio__hang');
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(INTERRUPTED_OUTPUT);
    expect(r.details?.classification?.kind).toBe('uncertain-write');
    expect(stdioCalls().filter(c => c.name === 'hang')).toHaveLength(1);

    // Same key with different args is a different logical call: refused, not resent.
    await expect(call(second, 'k-crash', 'mcp__stdio__hang', { other: 1 })).rejects.toThrow(/conflicting/);
    expect(stdioCalls().filter(c => c.name === 'hang')).toHaveLength(1);
  });

  it('marks readOnlyTools safe to replay and respects exposure', async () => {
    const host = await start({
      readOnlyTools: ['echo'],
      servers: [{ ...stdioServer(), toolExposure: { image: 'hidden', structured: 'codemode', fail: 'deferred' } }],
    });
    const by = (n: string) => allTools(host).find(t => t.name === `mcp__stdio__${n}`);
    expect(by('echo')?.replay).toBe('safe');
    expect(by('write')?.replay).toBe('unsafe');
    expect(by('image')).toBeUndefined();
    expect(by('structured')?.callers).toEqual(['tools']);
    expect(by('fail')?.deferred).toBe(true);
  });

  it('supports bare tool naming', async () => {
    const host = await start({ toolNaming: 'bare', servers: [stdioServer()] });
    expect(host.toolNames).toContain('echo');
    const r = await call(host, 'k-bare', 'echo', { text: 'bare' });
    expect(text(r)).toBe('bare');
  });

  it('exposes prompts and resources as durable feature tools', async () => {
    const host = await start({ servers: [stdioServer()] });
    const prompts = feature(host, 'mcp_prompts');
    const list = (await prompts.execute({ action: 'list', server: 'stdio' }, api('p1') as never, {})) as unknown as Result;
    expect(JSON.stringify(list.structuredOutput ?? text(list))).toContain('greet');
    const got = (await prompts.execute({ action: 'get', server: 'stdio', name: 'greet', arguments: { who: 'bob' } }, api('p2') as never, {})) as unknown as Result;
    expect(JSON.stringify(got.structuredOutput ?? text(got))).toContain('hello bob');

    const resources = feature(host, 'mcp_resources');
    const read = (await resources.execute({ action: 'read', server: 'stdio', uri: 'fixture://note' }, api('r1') as never, {})) as unknown as Result;
    expect(JSON.stringify(read.structuredOutput ?? text(read))).toContain('note fixture://note');
  });

  it('close() is idempotent, stops the stdio server and rejects later calls', async () => {
    const host = await start({ servers: [stdioServer()] });
    await call(host, 'k-c1', 'mcp__stdio__echo', { text: 'a' });
    await host.close();
    await host.close();
    await expect(call(host, 'k-c2', 'mcp__stdio__echo', { text: 'b' })).rejects.toThrow();
    expect(stdioCalls().filter(c => c.name === 'echo')).toHaveLength(1);
  });
});

describe('startDurableMcpHost: Streamable HTTP', () => {
  it('discovers and calls tools over HTTP with configured headers', async () => {
    const fx = await startHttpFixture({ token: 'tok' });
    closers.push(fx.close);
    const host = await start({ servers: [{ name: 'web', url: fx.url, headers: { Authorization: 'Bearer tok' } }] });
    expect(host.toolNames).toContain('mcp__web__echo');
    const r = await call(host, 'h-1', 'mcp__web__image');
    expect(r.output).toEqual([{ type: 'text', text: 'pic' }, { type: 'image', data: PNG, mimeType: 'image/png' }]);
    expect(fx.calls.map((c: { name: string }) => c.name)).toEqual(['image']);
  });

  it('replays completed HTTP calls across reopen without hitting the server again', async () => {
    const fx = await startHttpFixture();
    closers.push(fx.close);
    const servers = [{ name: 'web', url: fx.url }];
    const first = await start({ servers });
    expect(text(await call(first, 'h-w', 'mcp__web__write', { v: 'y' }))).toBe('wrote y #1');
    await first.close();
    const second = await start({ servers });
    expect(text(await call(second, 'h-w', 'mcp__web__write', { v: 'y' }))).toBe('wrote y #1');
    expect(fx.calls.filter((c: { name: string }) => c.name === 'write')).toHaveLength(1);
  });

  it('hosts stdio and HTTP servers side by side', async () => {
    const fx = await startHttpFixture();
    closers.push(fx.close);
    const host = await start({ servers: [stdioServer('local'), { name: 'web', url: fx.url }] });
    expect(host.toolNames).toEqual(expect.arrayContaining(['mcp__local__echo', 'mcp__web__echo']));
    expect(text(await call(host, 'm-1', 'mcp__local__echo', { text: 'L' }))).toBe('L');
    expect(text(await call(host, 'm-2', 'mcp__web__echo', { text: 'W' }))).toBe('W');
  });
});
