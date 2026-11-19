import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { ExtensionRegistry } from '@mcp-client/core';
import { ObservationMismatch, runExchange, supportsMutant } from '../src/conformance.js';
import { createTasksExtension, MemoryTaskStore, TASKS_ID } from '../src/index.js';
const path = (p: string) => new URL(p,import.meta.url);
const text = (p: string) => readFileSync(path(p),'utf8');
const dir = '../../fixtures/exchanges/ext/tasks/';
const fixtures = readdirSync(path(dir)).map(f => JSON.parse(text(dir+f)));
const rows = JSON.parse(text('../../conformance/requirements.json')).rows;
describe('Tier A tasks exchanges', () => {
  it('has six grouped fixtures', () => expect(fixtures).toHaveLength(6));
  for (const fx of fixtures) {
    it(fx.id, async () => {
      for (const req of fx.requirements) expect(rows.find((r:{id:string}) => r.id === req)?.openQuestion).toBeNull();
      await runExchange(fx);
    });
    for (const m of fx.mutants) it(m, async () => {
      expect(supportsMutant(m)).toBe(true);
      await expect(runExchange(fx,m)).rejects.toBeInstanceOf(ObservationMismatch);
    });
  }
  it('rejects malformed exchanges and unknown mutants as harness errors',async () => {
    for (const run of [runExchange(null),runExchange(fixtures[0],'unknown')]) {
      await expect(run).rejects.toHaveProperty('name','Error');
    }
  });
});
it('EXT-REG-1: importing never registers an extension',async () => {
  vi.resetModules(); const {ExtensionRegistry: Registry} = await import('@mcp-client/core');
  const spy = vi.spyOn(Registry.prototype,'register');
  try { await import('../src/index.js'); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
});
it('EXT-STAGE-1 and EXT-PIN-1: pinned opt-in beta',() => {
  const ext = createTasksExtension(); expect(ext.stage).toBe('beta'); expect(ext.defaultEnabled).toBe(false);
  expect(text('../PIN.md')).toContain(ext.pin); expect(text('../PIN.md')).toContain('specification/2026-07-28/tasks.md');
  expect(ext.capabilities(false)).toEqual({}); expect(createTasksExtension({healthy:false}).settings()).toBeUndefined();
});
it('EXT-PORT-1: extension-owned store isolates server namespaces',() => {
  const store = new MemoryTaskStore();
  for (const serverKey of ['a','b']) store.put({serverKey, taskId:'x', createdAt:5,lastStatus:'working'});
  store.delete('a','x'); expect(store.list('a')).toEqual([]); expect(store.get('b','x')?.createdAt).toBe(5);
  expect(text('../../core/src/ports.ts')).not.toContain('TaskStore');
});
it('EXT-STREAM-1: runtime depends on public ports, not transports',() => {
  for (const f of readdirSync(path('../src/'))) for (const m of text('../src/'+f).matchAll(/from ['"]([^'"]+)['"]/g)) {
    expect(m[1]).toMatch(/^(?:\.\/|node:|@mcp-client\/(core|mrtr-cache)$)/);
  }
});
it('rejects malformed task results before persisting',() => {
  const registry = new ExtensionRegistry(), ext = createTasksExtension({peerCapabilities:{extensions:{[TASKS_ID]:{}}}});
  registry.register(ext); const accept = registry.resolveResultType('task')!;
  for (const field of [{taskId:''},{status:'done'},{ttl:-1},{pollIntervalMs:Infinity},{inputRequests:[]},{error:1},{result:false}]) {
    expect(accept({taskId:'x',status:'working',...field}).kind).toBe('protocol-violation');
  }
  expect(ext.resumeAll()).toEqual([]);
});
