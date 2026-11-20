import { createHash } from 'node:crypto';
import { DurableCalls, type CallOutcome, type DurableCallStore, type ExecuteOptions, type PerKeyMutex, type RequestIntent } from './calls.js';
import { nestedCallKey } from './nested-key.js';
import { applyIdempotencyPolicy, type IdempotencyPolicy } from './policies.js';

/** What the store persists for a tool call: identity only, never arguments. */
export interface ToolIntent {
  method: 'tools/call'; server: string; name: string;
  /** Durable logical call id (the nested key), stable across restarts. */
  durableId: string;
  /** Actual wire request id for this attempt; fresh on every restart attempt. */
  requestId: string;
  /** sha256 of canonical effective args; the args themselves are never stored. */
  digest: string;
}
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;
export const argsDigest = (args: unknown): string =>
  createHash('sha256').update(JSON.stringify(canonical(args))).digest('hex');
export interface ToolCallInput {
  serverId: string;
  toolName: string;
  inputSchema: unknown;
  args: Readonly<Record<string, unknown>>;
}
export interface ToolWire { requestId: string; serverId: string; toolName: string; args: Readonly<Record<string, unknown>> }
type Child = Parameters<typeof nestedCallKey>[1];

export interface DurableToolAdapterDeps<Res> {
  store: DurableCallStore<ToolIntent, Res>;
  mutex: PerKeyMutex;
  /** Injected transport; receives the full request including args. */
  send: (request: ToolWire) => Promise<Res>;
  policies?: readonly IdempotencyPolicy[];
  /** Allocates wire request ids; defaults to crypto.randomUUID. */
  newRequestId?: () => string;
  restart?: Pick<ExecuteOptions<ToolIntent>, 'acceptDuplicate' | 'restartLimit' | 'readOnlyTools' | 'toolOverrides'>;
  /** Called only after the outcome has been committed to the store. */
  onWake?: (key: string, outcome: CallOutcome<Res>) => void | Promise<void>;
}

const describe = (r: ToolIntent): RequestIntent => ({ method: r.method, server: r.server, name: r.name, digest: r.digest, requestId: r.requestId });

export class DurableToolAdapter<Res> {
  private readonly calls: DurableCalls<ToolIntent, Res>;
  constructor(private readonly deps: DurableToolAdapterDeps<Res>) {
    this.calls = new DurableCalls<ToolIntent, Res>({ store: deps.store, mutex: deps.mutex });
  }
  private newId(): string { return this.deps.newRequestId?.() ?? crypto.randomUUID(); }
  async callTool(parent: string, child: Child, call: ToolCallInput): Promise<CallOutcome<Res>> {
    const key = nestedCallKey(parent, child);
    const args = applyIdempotencyPolicy({ ...call, logicalKey: key }, this.deps.policies);
    const intent: ToolIntent = { method: 'tools/call', server: call.serverId, name: call.toolName, durableId: key, digest: argsDigest(args), requestId: this.newId() };
    const outcome = await this.calls.execute(
      key,
      intent,
      // Send what was committed: the wire sees the stored requestId.
      (sent) => this.deps.send({ requestId: sent.requestId, serverId: call.serverId, toolName: call.toolName, args }),
      {
        ...this.deps.restart,
        tool: call.toolName,
        describe,
        restartRequest: (r) => ({ ...r, requestId: this.newId() }),
      },
    );
    await this.deps.onWake?.(key, outcome);
    return outcome;
  }
}
