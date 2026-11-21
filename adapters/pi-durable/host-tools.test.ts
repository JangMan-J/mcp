import { describe, expect, it, vi } from 'vitest';
import type { ToolIntent } from './adapter.js';
import type { CallRecord, DurableCallStore, PerKeyMutex } from './calls.js';
import * as ext from './extension.js';
import type { McpCallToolResult } from './extension.js';
import { CALL_TOOL_RESULT_SCHEMA, INTERRUPTED_OUTPUT, registerOperation, type OperationSpec } from './host-tools.js';
import { nestedCallKey } from './nested-key.js';

type Rec = CallRecord<ToolIntent, McpCallToolResult>;
function memStore(): DurableCallStore<ToolIntent, McpCallToolResult> & { map: Map<string, Rec> } {
  const map = new Map<string, Rec>();
  return {
    map,
    async get(k) { return map.get(k); },
    async commitIntent(k, request, meta) { map.set(k, { status: 'intent', request, ...(meta ? { meta } : {}) }); },
    async commitOutcome(k, result) { map.set(k, { ...map.get(k), status: 'completed', result }); },
  };
}
const mutex: PerKeyMutex = { withLock: (_k, fn) => fn() };
const ok: McpCallToolResult = { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AA', mimeType: 'image/png' }], structuredContent: { n: 1 }, _meta: { x: 1 } };

function setup(over: Partial<OperationSpec> = {}, deps: { acceptDuplicate?: boolean } = {}) {
  const store = memStore();
  const invoke = vi.fn(async (_a: Readonly<Record<string, unknown>>, _s: AbortSignal | undefined, _id: string) => ok);
  const onCancel = vi.fn();
  const reg = registerOperation(
    { name: 'mcp__s__t', serverId: 's', wireName: 't', inputSchema: { type: 'object' }, invoke, ...over },
    { store, mutex, onCancel, newRequestId: (() => { let i = 0; return () => `r${++i}`; })(), ...deps },
  );
  return { store, invoke, onCancel, reg };
}

describe('registerOperation', () => {
  it('builds a 1.6.0-shaped registration and ContentBlock output', async () => {
    const { reg, invoke } = setup();
    expect(reg).toMatchObject({ name: 'mcp__s__t', replay: 'unsafe', callers: ['model', 'tools'] });
    expect(reg.structuredOutputSchema).toBe(ext.CALL_TOOL_RESULT_SCHEMA);
    expect(CALL_TOOL_RESULT_SCHEMA).toBe(ext.CALL_TOOL_RESULT_SCHEMA);
    expect(INTERRUPTED_OUTPUT).toBe(ext.INTERRUPTED_OUTPUT);
    const r = await reg.execute({ a: 1 }, { callId: 'c1' }, {});
    expect(invoke).toHaveBeenCalledWith({ a: 1 }, expect.any(AbortSignal), 'r1');
    expect(r.output).toEqual([{ type: 'text', text: 'hi' }, { type: 'image', data: 'AA', mimeType: 'image/png' }]);
    expect(r.structuredOutput).toEqual({ content: ok.content, structuredContent: { n: 1 } });
    expect(r.isError).toBeUndefined();
  });

  it('exposure and readOnly map to callers/deferred/replay', () => {
    expect(setup({ exposure: 'codemode' }).reg.callers).toEqual(['tools']);
    const d = setup({ exposure: 'deferred', readOnly: true }).reg;
    expect(d.deferred).toBe(true);
    expect(d.replay).toBe('safe');
    expect(setup({ readOnly: true, override: 'interrupt' }).reg.replay).toBe('unsafe');
  });

  it('replays a completed call from the store without invoking', async () => {
    const { reg, invoke } = setup();
    const a = await reg.execute({ a: 1 }, { callId: 'c1' }, {});
    const b = await reg.execute({ a: 1 }, { callId: 'c1' }, {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(b).toEqual(a);
  });

  it('throws on digest mismatch for the same call id, even when completed', async () => {
    const { reg } = setup();
    await reg.execute({ a: 1 }, { callId: 'c1' }, {});
    await expect(reg.execute({ a: 2 }, { callId: 'c1' }, {})).rejects.toThrow(/conflicting intent/);
  });

  it('recovery: an unfinished write is interrupted, not resent', async () => {
    const { reg, invoke, store } = setup();
    invoke.mockImplementationOnce(() => new Promise(() => {})); // host "dies" mid-call
    void reg.execute({ a: 1 }, { callId: 'c1' }, {});
    await vi.waitFor(() => expect(store.map.get(nestedCallKey('c1', { key: 'mcp' }))?.status).toBe('intent'));
    const r = await reg.execute({ a: 1 }, { callId: 'c1' }, {});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(r.isError).toBe(true);
    expect(r.output).toEqual([{ type: 'text', text: INTERRUPTED_OUTPUT }]);
    expect(r.details).toMatchObject({ status: 'interrupted', classification: { kind: 'uncertain-write' } });
  });

  it('recovery: readOnly or acceptDuplicate resends with a fresh request id', async () => {
    for (const s of [setup({ readOnly: true }), setup({}, { acceptDuplicate: true })]) {
      const key = nestedCallKey('c1', { key: 'mcp' });
      s.invoke.mockImplementationOnce(() => new Promise(() => {}));
      void s.reg.execute({ a: 1 }, { callId: 'c1' }, {});
      await vi.waitFor(() => expect(s.store.map.get(key)?.status).toBe('intent'));
      const r = await s.reg.execute({ a: 1 }, { callId: 'c1' }, {});
      expect(s.invoke).toHaveBeenCalledTimes(2);
      expect(r.isError).toBeUndefined();
      const id = s.store.map.get(key)?.request?.requestId;
      expect(id).not.toBe('r1');
      expect(s.invoke).toHaveBeenLastCalledWith({ a: 1 }, expect.any(AbortSignal), id);
    }
  });

  it('surfaces MCP isError and stringifies unknown content', async () => {
    const { reg, invoke } = setup();
    invoke.mockResolvedValueOnce({ content: [{ type: 'resource', uri: 'u' }], isError: true });
    const r = await reg.execute({}, { callId: 'c2' }, {});
    expect(r.isError).toBe(true);
    expect(r.output).toEqual([{ type: 'text', text: '{"type":"resource","uri":"u"}' }]);
  });

  it('cancel is idempotent and never invokes', async () => {
    const { reg, invoke, onCancel } = setup();
    await reg.cancel({}, { callId: 'c3', checkpoint: { p: 1 } }, {});
    await reg.cancel({}, { callId: 'c3' }, {});
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith({ callId: 'c3', name: 'mcp__s__t', checkpoint: { p: 1 } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invoke signal follows the context signal', async () => {
    const { reg, invoke } = setup();
    const outer = new AbortController();
    let seen: AbortSignal | undefined;
    invoke.mockImplementationOnce(async (_a, s) => { seen = s; outer.abort(); return ok; });
    await reg.execute({}, { callId: 'c4' }, { signal: outer.signal });
    expect(seen?.aborted).toBe(true);
  });

  it('cancel aborts the executing invoke even without onCancel, every time', async () => {
    const store = memStore();
    const seen: AbortSignal[] = [];
    const invoke = vi.fn((_a: Readonly<Record<string, unknown>>, s: AbortSignal | undefined) => new Promise<McpCallToolResult>((_res, rej) => {
      seen.push(s!);
      s!.addEventListener('abort', () => rej(new Error('aborted')));
    }));
    const reg = registerOperation({ name: 'n', serverId: 's', wireName: 't', inputSchema: {}, invoke }, { store, mutex });
    for (const n of [1, 2]) {
      store.map.delete(nestedCallKey('c5', { key: 'mcp' }));
      const run = reg.execute({}, { callId: 'c5' }, {});
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(n));
      await reg.cancel({}, { callId: 'c5' }, {});
      await expect(run).rejects.toThrow('aborted');
    }
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.aborted)).toBe(true);
  });
});
