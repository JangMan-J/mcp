import type { CallOutcome, DurableCalls, Send } from './calls.js';
import { nestedCallKey } from './nested-key.js';
import { applyIdempotencyPolicy, type IdempotencyPolicy } from './policies.js';

type ToolCall = Omit<Parameters<typeof applyIdempotencyPolicy>[0], 'logicalKey'>;
export type NestedToolRequest = Omit<ToolCall, 'inputSchema'>;

export function executeNestedCall<Res>(
  calls: DurableCalls<NestedToolRequest, Res>,
  parent: string,
  child: Parameters<typeof nestedCallKey>[1],
  call: ToolCall,
  send: Send<NestedToolRequest, Res>,
  policies?: readonly IdempotencyPolicy[],
): Promise<CallOutcome<Res>> {
  const logicalKey = nestedCallKey(parent, child);
  const args = applyIdempotencyPolicy({ ...call, logicalKey }, policies);
  return calls.execute(logicalKey, { serverId: call.serverId, toolName: call.toolName, args }, send);
}
