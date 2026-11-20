import { DurableCalls, type CallOutcome, type DurableCallStore, type ExecuteOptions, type PerKeyMutex, type RequestIntent } from './calls.js';
import { nestedCallKey } from './nested-key.js';
import { applyIdempotencyPolicy, type IdempotencyPolicy } from './policies.js';

/** What the store persists for a tool call: identity only, never arguments. */
export interface ToolIntent { method: 'tools/call'; server: string; name: string }
export interface ToolCallInput {
  serverId: string;
  toolName: string;
  inputSchema: unknown;
  args: Readonly<Record<string, unknown>>;
}
export interface ToolWire { serverId: string; toolName: string; args: Readonly<Record<string, unknown>> }
type Child = Parameters<typeof nestedCallKey>[1];

export interface DurableToolAdapterDeps<Res> {
  store: DurableCallStore<ToolIntent, Res>;
  mutex: PerKeyMutex;
  /** Injected transport; receives the full request including args. */
  send: (request: ToolWire) => Promise<Res>;
  policies?: readonly IdempotencyPolicy[];
  restart?: Pick<ExecuteOptions<ToolIntent>, 'acceptDuplicate' | 'restartLimit' | 'readOnlyTools' | 'toolOverrides'>;
  /** Called only after the outcome has been committed to the store. */
  onWake?: (key: string, outcome: CallOutcome<Res>) => void | Promise<void>;
}

const describe = (r: ToolIntent): RequestIntent => ({ method: r.method, server: r.server, name: r.name });

export class DurableToolAdapter<Res> {
  private readonly calls: DurableCalls<ToolIntent, Res>;
  constructor(private readonly deps: DurableToolAdapterDeps<Res>) {
    this.calls = new DurableCalls<ToolIntent, Res>({ store: deps.store, mutex: deps.mutex });
  }
  async callTool(parent: string, child: Child, call: ToolCallInput): Promise<CallOutcome<Res>> {
    const key = nestedCallKey(parent, child);
    const args = applyIdempotencyPolicy({ ...call, logicalKey: key }, this.deps.policies);
    const intent: ToolIntent = { method: 'tools/call', server: call.serverId, name: call.toolName };
    const outcome = await this.calls.execute(
      key,
      intent,
      () => this.deps.send({ serverId: call.serverId, toolName: call.toolName, args }),
      { ...this.deps.restart, tool: call.toolName, describe },
    );
    await this.deps.onWake?.(key, outcome);
    return outcome;
  }
}
