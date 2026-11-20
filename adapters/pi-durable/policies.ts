export interface IdempotencyPolicy {
  readonly serverId: string;
  readonly toolName: string;
  readonly field: string;
}

interface ToolCall {
  serverId: string;
  toolName: string;
  inputSchema: unknown;
  args: Readonly<Record<string, unknown>>;
  /** Host-assigned once per logical call, not per transport attempt. */
  logicalKey: string;
}

function ownField(object: unknown, field: string): unknown {
  if (!object || typeof object !== 'object' || Array.isArray(object) || !Object.hasOwn(object, field)) return undefined;
  return (object as Record<string, unknown>)[field];
}

/** Prepare arguments only; a key is not authorization to retry a write. */
export function applyIdempotencyPolicy(
  call: ToolCall,
  policies: readonly IdempotencyPolicy[] = [],
): Readonly<Record<string, unknown>> {
  const policy = policies.find(p => p.serverId === call.serverId && p.toolName === call.toolName);
  if (!policy || Object.hasOwn(call.args, policy.field)) return call.args;

  const declaration = ownField(ownField(call.inputSchema, 'properties'), policy.field);
  if (ownField(declaration, 'type') !== 'string') return call.args;
  return { ...call.args, [policy.field]: call.logicalKey };
}
