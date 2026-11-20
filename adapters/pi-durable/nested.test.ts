import { expect, it, vi } from 'vitest';
import { DurableCalls, type CallRecord } from './calls.js';
import { executeNestedCall, type NestedToolRequest } from './nested.js';

it('replays the same nested invocation without sending it again', async () => {
  const records = new Map<string, CallRecord<NestedToolRequest, number>>();
  const open = () => new DurableCalls<NestedToolRequest, number>({
    store: {
      async get(key) { return records.get(key); },
      async commitIntent(key, request) { records.set(key, { status: 'intent', request }); },
      async commitOutcome(key, result) { records.set(key, { status: 'completed', result }); },
    },
    mutex: { withLock: (_key, fn) => fn() },
  });
  const send = vi.fn(async (_request: NestedToolRequest) => 73);
  const invoke = (position: number) => executeNestedCall(open(), 'parent', { position }, {
    serverId: 'billing',
    toolName: 'charge',
    inputSchema: { properties: { requestKey: { type: 'string' } } },
    args: { amount: 42 },
  }, send, [{ serverId: 'billing', toolName: 'charge', field: 'requestKey' }]);

  await expect(invoke(0)).resolves.toEqual({ status: 'completed', result: 73 });
  send.mockResolvedValue(74);
  await expect(invoke(1)).resolves.toEqual({ status: 'completed', result: 74 });
  await expect(invoke(0)).resolves.toEqual({ status: 'completed', result: 73 });
  expect(send.mock.calls).toEqual([
    [{ serverId: 'billing', toolName: 'charge', args: { amount: 42, requestKey: '["parent","position","0"]' } }],
    [{ serverId: 'billing', toolName: 'charge', args: { amount: 42, requestKey: '["parent","position","1"]' } }],
  ]);
});
