import { expect, it, vi } from 'vitest';
import type { CallRecord } from './calls.js';
import { DurableToolAdapter, argsDigest, type ToolIntent } from './adapter.js';

const setup = (restart?: ConstructorParameters<typeof DurableToolAdapter<number>>[0]['restart']) => {
  const records = new Map<string, CallRecord<ToolIntent, number>>();
  const events: string[] = [];
  const committed: ToolIntent[] = [];
  const store = {
    async get(key: string) { return records.get(key); },
    async commitIntent(key: string, request: ToolIntent, meta?: { attempts: number }) {
      events.push('intent');
      committed.push(request);
      records.set(key, meta ? { status: 'intent', request, meta } : { status: 'intent', request });
    },
    async commitOutcome(key: string, result: number) {
      events.push('commit');
      records.set(key, { status: 'completed', result });
    },
  };
  const send = vi.fn(async () => { events.push('send'); return 5; });
  const onWake = vi.fn(() => { events.push('wake'); });
  let n = 0;
  const adapter = new DurableToolAdapter<number>({
    store, mutex: { withLock: (_k, fn) => fn() }, send, onWake,
    ...(restart ? { restart } : {}), newRequestId: () => `r${++n}`,
    policies: [{ serverId: 's', toolName: 'pay', field: 'requestKey' }],
  });
  return { committed, records, events, send, adapter };
};
const call = (args: Record<string, unknown>) => ({
  serverId: 's', toolName: 'pay', inputSchema: { properties: { requestKey: { type: 'string' } } }, args,
});

it('[PICD-1] commits durable id and digest (no raw args) in order, and keeps restart identity', async () => {
  const { committed, records, events, send, adapter } = setup();
  const key = '["p","position","0"]';
  const wire = { secret: 'x', requestKey: key };

  await expect(adapter.callTool('p', { position: 0 }, call({ secret: 'x' }))).resolves.toEqual({ status: 'completed', result: 5 });
  expect(events).toEqual(['intent', 'send', 'commit', 'wake']);
  expect(send).toHaveBeenCalledWith({ serverId: 's', toolName: 'pay', args: wire, requestId: 'r1' });

  // Restart: same id + same digest -> interrupted as uncertain write, no resend.
  const intent: ToolIntent = { method: 'tools/call', server: 's', name: 'pay', durableId: '["p","position","1"]',
    requestId: 'old', digest: argsDigest({ secret: 'x', requestKey: '["p","position","1"]' }) };
  records.set(intent.durableId, { status: 'intent', request: intent, meta: { attempts: 1 } });
  const out = await adapter.callTool('p', { position: 1 }, call({ secret: 'x' }));
  expect(out).toMatchObject({ status: 'interrupted', classification: { kind: 'uncertain-write', intent: { digest: intent.digest } } });
  expect(send).toHaveBeenCalledTimes(1);

  // Restart with different args -> digest identity conflict.
  records.set(intent.durableId, { status: 'intent', request: intent, meta: { attempts: 1 } });
  await expect(adapter.callTool('p', { position: 1 }, call({ secret: 'y' }))).rejects.toThrow('conflicting intent identity');

  // First call's committed intent carries id + digest, never args.
  expect(committed[0]).toEqual({ requestId: 'r1', method: 'tools/call', server: 's', name: 'pay', durableId: key, digest: argsDigest(wire) });
  expect(JSON.stringify(committed)).not.toContain('secret');
});

it('allocates a fresh wire requestId on replay and sends the committed one', async () => {
  const { committed, records, send, adapter } = setup({ acceptDuplicate: true });
  const durableId = '["p","position","0"]';
  const args = { secret: 'x', requestKey: durableId };
  records.set(durableId, { status: 'intent', meta: { attempts: 1 }, request: {
    method: 'tools/call', server: 's', name: 'pay', durableId, requestId: 'old', digest: argsDigest(args) } });
  await expect(adapter.callTool('p', { position: 0 }, call({ secret: 'x' }))).resolves.toEqual({ status: 'completed', result: 5 });
  expect(committed).toHaveLength(1);
  expect(committed[0]?.requestId).not.toBe('old');
  expect(committed[0]?.requestId).toBe('r2');
  expect(committed[0]?.durableId).toBe(durableId);
  expect(send).toHaveBeenCalledWith({ requestId: 'r2', serverId: 's', toolName: 'pay', args });
  expect(JSON.stringify(committed)).not.toContain('secret');
});
