import { describe, expect, it } from 'vitest';
import { applyIdempotencyPolicy } from './policies.js';

const call = {
  serverId: 'billing', toolName: 'charge', logicalKey: 'payment-123',
  inputSchema: { type: 'object', properties: { requestKey: { type: 'string' } } },
  args: Object.freeze({ amount: 42 }),
};
const policies = [{ serverId: 'billing', toolName: 'charge', field: 'requestKey' }];

describe('PICD-7', () => {
  it('puts the same host key on fresh attempts of one logical call', () => {
    const expected = { amount: 42, requestKey: 'payment-123' };
    expect(applyIdempotencyPolicy(call, policies)).toEqual(expected);
    expect(applyIdempotencyPolicy({ ...call, args: { amount: 42 } }, policies)).toEqual(expected);
  });

  it('requires an explicit opt-in for the exact server and tool', () => {
    expect(applyIdempotencyPolicy(call)).toEqual(call.args);
    expect(applyIdempotencyPolicy({ ...call, serverId: 'other' }, policies)).toEqual(call.args);
    expect(applyIdempotencyPolicy({ ...call, toolName: 'refund' }, policies)).toEqual(call.args);
  });

  it.each([{}, { properties: {} }, { properties: { requestKey: { type: 'integer' } } }])(
    'skips a schema without an explicit string field: %j', inputSchema => {
      expect(applyIdempotencyPolicy({ ...call, inputSchema }, policies)).toEqual(call.args);
    },
  );

  it('preserves even a falsy caller-supplied key', () => {
    const args = { ...call.args, requestKey: '' };
    expect(applyIdempotencyPolicy({ ...call, args }, policies)).toEqual(args);
  });
});
