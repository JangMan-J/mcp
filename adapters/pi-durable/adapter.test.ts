import { expect, it, vi } from 'vitest';
import type { CallRecord } from './calls.js';
import { DurableToolAdapter, type ToolIntent } from './adapter.js';

it('persists identity only, wakes after commit, and interrupts a restarted write', async () => {
  const records = new Map<string, CallRecord<ToolIntent, number>>();
  const events: string[] = [];
  const store = {
    async get(key: string) { return records.get(key); },
    async commitIntent(key: string, request: ToolIntent, meta?: { attempts: number }) {
      records.set(key, { status: 'intent', request, meta });
    },
    async commitOutcome(key: string, result: number) {
      events.push('commit');
      records.set(key, { status: 'completed', result });
    },
  };
  const send = vi.fn(async () => 5);
  const onWake = vi.fn(() => { events.push('wake'); });
  const adapter = new DurableToolAdapter<number>({
    store, mutex: { withLock: (_k, fn) => fn() }, send, onWake,
    policies: [{ serverId: 's', toolName: 'pay', field: 'requestKey' }],
  });
  const call = { serverId: 's', toolName: 'pay', inputSchema: { properties: { requestKey: { type: 'string' } } }, args: { secret: 'x' } };

  await expect(adapter.callTool('p', { position: 0 }, call)).resolves.toEqual({ status: 'completed', result: 5 });
  expect(events).toEqual(['commit', 'wake']);
  expect(send).toHaveBeenCalledWith({ serverId: 's', toolName: 'pay', args: { secret: 'x', requestKey: '["p","position","0"]' } });

  // Simulated restart: intent without outcome.
  records.set('["p","position","1"]', { status: 'intent', request: { method: 'tools/call', server: 's', name: 'pay' }, meta: { attempts: 1 } });
  const out = await adapter.callTool('p', { position: 1 }, call);
  expect(out).toMatchObject({ status: 'interrupted', classification: { kind: 'uncertain-write' } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify([...records.values()])).not.toContain('secret');
});
