import { describe, expect, it, vi } from 'vitest';
import type { ToolIntent, ToolWire } from './adapter.ts';
import type { CallRecord, DurableCallStore, PerKeyMutex } from './calls.ts';
import {
  CALL_TOOL_RESULT_SCHEMA, INTERRUPTED_OUTPUT, createDurableMcpExtension, durableToolNames, executeNestedMcpTool,
  validateDurableNestedKey, type DurableMcpExtensionOptions, type DurableToolExecutionApi, type DurableToolRegistration,
  type McpCallToolResult,
} from './extension.ts';

type Rec = CallRecord<ToolIntent, McpCallToolResult>;
class Store implements DurableCallStore<ToolIntent, McpCallToolResult> {
  constructor(readonly backing = new Map<string, Rec>(), readonly events: string[] = [], public crash = false) {}
  async get(key: string) { return this.backing.get(key); }
  async commitIntent(key: string, request: ToolIntent, meta?: { attempts: number }) {
    this.events.push('intent');
    this.backing.set(key, { status: 'intent', request, ...(meta ? { meta } : {}) });
  }
  async commitOutcome(key: string, result: McpCallToolResult) {
    if (this.crash) throw new Error('crash after send');
    this.events.push('outcome');
    this.backing.set(key, { status: 'completed', result });
  }
}
const mutex: PerKeyMutex = { withLock: (_k, fn) => fn() };
const schema = { type: 'object', properties: { q: { type: 'string' } } };
const tools = [
  { name: 'search', description: 'Search', inputSchema: schema },
  { name: 'write', description: 'Write', inputSchema: schema },
  { name: 'secret', inputSchema: schema },
];
const reply: McpCallToolResult = {
  content: [{ type: 'text', text: 'hello' }], structuredContent: { n: 1 }, _meta: { trace: 'x' },
};
const make = (over: Partial<DurableMcpExtensionOptions> = {}, store = new Store()) => {
  const send = vi.fn(async (_r: ToolWire) => { store.events.push('send'); return reply; });
  const ext = createDurableMcpExtension({
    serverId: 'srv', description: 'Test server', tools, store, mutex, send, ...over,
  });
  return { ext, send, store };
};
const tool = (ext: ReturnType<typeof make>['ext'], name: string): DurableToolRegistration => {
  const t = ext.tools?.find(x => x.name === `mcp__srv__${name}`);
  if (!t) throw new Error(`missing ${name}`);
  return t;
};
const api = (callId = 'call-1', extra: Partial<DurableToolExecutionApi> = {}): DurableToolExecutionApi => ({
  callId, executeTool: vi.fn(async () => 'nested'), ...extra,
});

describe('replay policy', () => {
  it('defaults MCP tools/call to unsafe', () => {
    const { ext } = make();
    expect(ext.tools?.map(t => t.replay)).toEqual(['unsafe', 'unsafe', 'unsafe']);
  });
  it('readOnlyTools makes safe; interrupt override wins; replay override makes safe', () => {
    const { ext } = make({
      readOnlyTools: ['search', 'secret'], toolOverrides: { secret: 'interrupt', write: 'replay' },
    });
    expect(tool(ext, 'search').replay).toBe('safe');
    expect(tool(ext, 'write').replay).toBe('safe');
    expect(tool(ext, 'secret').replay).toBe('unsafe');
  });
});

describe('exposure', () => {
  it('maps codemode, deferred, hidden with exact and * lookup', () => {
    const { ext } = make({ toolExposure: { search: 'codemode', write: 'deferred', '*': 'hidden' } });
    expect(ext.tools?.map(t => t.name)).toEqual(['mcp__srv__search', 'mcp__srv__write']);
    expect(tool(ext, 'search').callers).toEqual(['tools']);
    expect(tool(ext, 'write').deferred).toBe(true);
    expect(tool(ext, 'write').callers).toBeUndefined();
    expect(ext.sections?.map(s => s.key)).toEqual(['mcp_servers']);
  });
  it('direct is offered to both model and tools', () => {
    const { ext } = make();
    expect(tool(ext, 'search').callers).toEqual(['model', 'tools']);
    expect(tool(ext, 'search').deferred).toBeUndefined();
  });
  it('fully hidden server has no tools and no section', () => {
    const { ext } = make({ exposure: 'hidden' });
    expect(ext.tools).toEqual([]);
    expect(ext.sections).toEqual([]);
  });
  it('section renders server and tools', async () => {
    const { ext } = make({ instructions: 'Be nice', toolExposure: { secret: 'hidden' } });
    const text = await ext.sections?.[0]?.render();
    expect(text).toContain('Test server');
    expect(text).toContain('Be nice');
    expect(text).toContain('mcp__srv__search');
    expect(text).not.toContain('secret');
  });
});

describe('naming', () => {
  it('is deterministic, valid and hash-suffixed on overflow or ambiguity', () => {
    const long = 'x'.repeat(80);
    const names = durableToolNames('srv', ['ok', 'a.b', 'a_b', long]);
    expect(names.get('ok')).toBe('mcp__srv__ok');
    expect(names.get('a_b')).toBe('mcp__srv__a_b');
    expect(names.get('a.b')).toMatch(/^mcp__srv__a_b_[0-9a-f]{8}$/);
    for (const n of names.values()) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(new Set(names.values()).size).toBe(4);
    expect(durableToolNames('srv', [long]).get(long)).toBe(names.get(long));
    expect(durableToolNames('a__b', ['c']).get('c')).toMatch(/_[0-9a-f]{8}$/);
  });
});

describe('execute', () => {
  it('commits intent before send and outcome before wake; returns structuredOutput', async () => {
    const { ext, send, store } = make();
    const res = await tool(ext, 'search').execute({ q: 'a' }, api(), {});
    expect(store.events).toEqual(['intent', 'send', 'outcome']);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.output).toBe('hello');
    expect(res.isError).toBeUndefined();
    expect(res.structuredOutput).toEqual({ content: [{ type: 'text', text: 'hello' }], structuredContent: { n: 1 } });
    expect(tool(ext, 'search').structuredOutputSchema).toBe(CALL_TOOL_RESULT_SCHEMA);
  });
  it('replays a completed CallToolResult from storage without resending', async () => {
    const store = new Store();
    await tool(make({}, store).ext, 'search').execute({ q: 'a' }, api(), {});
    const reopened = make({}, store);
    const res = await tool(reopened.ext, 'search').execute({ q: 'a' }, api(), {});
    expect(reopened.send).not.toHaveBeenCalled();
    expect(res.structuredOutput).toEqual({ content: [{ type: 'text', text: 'hello' }], structuredContent: { n: 1 } });
  });
  it('surfaces isError from the MCP result', async () => {
    const store = new Store();
    const send = vi.fn(async () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }));
    const ext = createDurableMcpExtension({ serverId: 'srv', description: 'd', tools, store, mutex, send });
    const res = await tool(ext, 'write').execute({}, api(), {});
    expect(res).toMatchObject({ output: 'boom', isError: true });
  });
  it('crash then reopen surfaces interrupted uncertain-write without resending', async () => {
    const store = new Store();
    store.crash = true;
    await expect(tool(make({}, store).ext, 'write').execute({ q: 'a' }, api(), {})).rejects.toThrow('crash');
    store.crash = false;
    const reopened = make({}, store);
    const res = await tool(reopened.ext, 'write').execute({ q: 'a' }, api(), {});
    expect(reopened.send).not.toHaveBeenCalled();
    expect(res.output).toBe(INTERRUPTED_OUTPUT);
    expect(res.isError).toBe(true);
    expect(res.details).toMatchObject({
      status: 'interrupted',
      classification: { kind: 'uncertain-write', evidence: 'host-restart', intent: { method: 'tools/call', name: 'write' } },
    });
  });
  it('readOnly tool restarts after crash; acceptDuplicate allows resend', async () => {
    for (const over of [{ readOnlyTools: ['write'] }, { acceptDuplicate: true }]) {
      const store = new Store();
      store.crash = true;
      await expect(tool(make(over, store).ext, 'write').execute({}, api(), {})).rejects.toThrow();
      store.crash = false;
      const reopened = make(over, store);
      const res = await tool(reopened.ext, 'write').execute({}, api(), {});
      expect(reopened.send).toHaveBeenCalledTimes(1);
      expect(res.output).toBe('hello');
    }
  });
});

describe('cancel', () => {
  it('is idempotent and never sends', async () => {
    const onCancel = vi.fn();
    const { ext, send } = make({ onCancel });
    const t = tool(ext, 'write');
    const a = api('parked', { checkpoint: { step: 2 } });
    await t.cancel?.({}, a, {});
    await t.cancel?.({}, a, {});
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ callId: 'parked', toolName: 'write', checkpoint: { step: 2 } });
    expect(send).not.toHaveBeenCalled();
    expect(a.executeTool).not.toHaveBeenCalled();
  });
  it('works without onCancel', async () => {
    const { ext } = make();
    await expect(tool(ext, 'write').cancel?.({}, api(), {})).resolves.toBeUndefined();
  });
});

describe('nested keys', () => {
  it('validates explicit keys', () => {
    for (const bad of ['', 'a/b', '__proto__', '1', '42']) expect(() => validateDurableNestedKey(bad)).toThrow(TypeError);
    for (const good of ['a', '0', '01', 'k-1', '-1']) expect(() => validateDurableNestedKey(good)).not.toThrow();
  });
  it('positional calls delegate; explicit keys are validated', async () => {
    const a = api();
    await expect(executeNestedMcpTool(a, 'mcp__srv__search', { q: 1 }, {})).resolves.toBe('nested');
    expect(a.executeTool).toHaveBeenCalledWith('mcp__srv__search', { q: 1 }, {}, undefined);
    await executeNestedMcpTool(a, 'x', {}, {}, { key: 'step' });
    expect(a.executeTool).toHaveBeenLastCalledWith('x', {}, {}, { key: 'step' });
    expect(() => executeNestedMcpTool(a, 'x', {}, {}, { key: '2' })).toThrow(TypeError);
  });
  it('requires an explicit key after a wake', async () => {
    const a = api('c', { wake: { reason: 'timer' } });
    expect(() => executeNestedMcpTool(a, 'x', {}, {})).toThrow('After a wake, nested MCP tool calls require an explicit key');
    await expect(executeNestedMcpTool(a, 'x', {}, {}, { key: 'k' })).resolves.toBe('nested');
  });
});
