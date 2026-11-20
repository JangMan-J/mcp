import { expect, it, vi } from 'vitest';
import type { CallRecord } from './calls.js';
import { DurableToolAdapter, argsDigest, type ToolIntent } from './adapter.js';

const setup = () => {
  const records = new Map<string, CallRecord<ToolIntent, number>>();
  const events: string[] = [];
  const committed: ToolIntent[] = [];
  const store = {
    async get(key: string) { return records.get(key); },
    async commitIntent(key: string, request: ToolIntent, meta?: { attempts: number }) {
      events.push('intent');
      committed.push(request);
      records.set(key, { status: 'intent', request, meta });
    },
    async commitOutcome(key: string, result: number) {
      events.push('commit');
      records.set(key, { status: 'completed', result });
    },
  };
  const send = vi.fn(async () => { events.push('send'); return 5; });
  const onWake = vi.fn(() => { events.push('wake'); });
  const adapter = new DurableToolAdapter<number>({
    store, mutex: { withLock: (_k, fn) => fn() }, send, onWake,
    policies: [{ serverId: 's', toolName: 'pay', field: 'requestKey' }],
  });
  return { committed, records, events, send, adapter };
};
const call = (args: Record<string, unknown>) => ({
  serverId: 's', toolName: 'pay', inputSchema: { properties: { requestKey: { type: 'string' } } }, args,
});

it('commits durable id and digest (no raw args) in order, and keeps restart identity', async () => {
  const { committed, records, events, send, adapter } = setup();
  const key = '["p","position","0"]';
  const wire = { secret: 'x', requestKey: key };

  await expect(adapter.callTool('p', { position: 0 }, call({ secret: 'x' }))).resolves.toEqual({ status: 'completed', result: 5 });
  expect(events).toEqual(['intent', 'send', 'commit', 'wake']);
  expect(send).toHaveBeenCalledWith({ serverId: 's', toolName: 'pay', args: wire });

  // Restart: same id + same digest -> interrupted as uncertain write, no resend.
  const intent: ToolIntent = { method: 'tools/call', server: 's', name: 'pay', durableId: '["p","position","1"]',
    digest: argsDigest({ secret: 'x', requestKey: '["p","position","1"]' }) };
  records.set(intent.durableId, { status: 'intent', request: intent, meta: { attempts: 1 } });
  const out = await adapter.callTool('p', { position: 1 }, call({ secret: 'x' }));
  expect(out).toMatchObject({ status: 'interrupted', classification: { kind: 'uncertain-write', intent: { digest: intent.digest } } });
  expect(send).toHaveBeenCalledTimes(1);

  // Restart with different args -> digest identity conflict.
  records.set(intent.durableId, { status: 'intent', request: intent, meta: { attempts: 1 } });
  await expect(adapter.callTool('p', { position: 1 }, call({ secret: 'y' }))).rejects.toThrow('conflicting intent identity');

  // First call's committed intent carries id + digest, never args.
  expect(committed[0]).toEqual({ method: 'tools/call', server: 's', name: 'pay', durableId: key, digest: argsDigest(wire) });
  expect(JSON.stringify(committed)).not.toContain('secret');
});
