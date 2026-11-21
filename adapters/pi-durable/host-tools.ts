import { argsDigest, type ToolIntent } from './adapter.js';
import { DurableCalls, type CallOutcome, type DurableCallStore, type PerKeyMutex, type RequestIntent } from './calls.js';
import { CALL_TOOL_RESULT_SCHEMA, INTERRUPTED_OUTPUT, type McpCallToolResult, type McpContent } from './extension.js';
import { nestedCallKey } from './nested-key.js';
import { applyIdempotencyPolicy, type IdempotencyPolicy } from './policies.js';

// Unified durable registration/call engine. Shapes structurally match pi-durable@1.6.0
// `ToolRegistration` (harness/types.d.ts); nothing here imports Pi.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** pi-durable@1.6.0 ToolResultMessage content block. */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

/** `abortSignal` is the pi-durable/chord `Context` field; `signal` is the host wrapper's own. Both are honored. */
export interface HostToolContext { readonly abortSignal?: AbortSignal | undefined; readonly signal?: AbortSignal }
/** The subset of pi-durable's ToolExecutionApi the engine reads. */
export interface HostToolApi { readonly callId: string; readonly checkpoint?: unknown; readonly wake?: unknown }

export interface HostToolResult {
  readonly output: ContentBlock[];
  readonly isError?: boolean;
  readonly details?: JsonValue;
  readonly structuredOutput?: JsonValue;
}

export type Exposure = 'direct' | 'codemode' | 'deferred';

export interface HostToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly replay: 'safe' | 'unsafe';
  readonly structuredOutputSchema: Record<string, unknown>;
  readonly callers?: readonly ('model' | 'tools')[];
  readonly deferred?: true;
  execute(args: unknown, api: HostToolApi, context: HostToolContext): Promise<HostToolResult>;
  cancel(args: unknown, api: HostToolApi, context: HostToolContext): Promise<void>;
}

export interface OperationSpec {
  /** Registered (model-facing) tool name. */
  readonly name: string;
  readonly serverId: string;
  /** Name sent on the wire / recorded in the intent. */
  readonly wireName: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly exposure?: Exposure;
  /** Read-only operations may re-run after a host restart. */
  readonly readOnly?: boolean;
  /** Operator override; wins over readOnly and acceptDuplicate. */
  readonly override?: 'replay' | 'interrupt';
  /** Performs the operation. Only called after the intent has been committed; `requestId` is the committed wire id. */
  invoke(args: Readonly<Record<string, unknown>>, signal: AbortSignal | undefined, requestId: string): Promise<McpCallToolResult>;
}

export interface OperationDeps {
  readonly store: DurableCallStore<ToolIntent, McpCallToolResult>;
  readonly mutex: PerKeyMutex;
  /** Operator opt-in to resend an interrupted write after restart (may duplicate the side effect). */
  readonly acceptDuplicate?: boolean;
  readonly restartLimit?: number;
  readonly policies?: readonly IdempotencyPolicy[];
  readonly newRequestId?: () => string;
  readonly onCancel?: (info: { callId: string; name: string; checkpoint?: unknown }) => void | Promise<void>;
}

export { CALL_TOOL_RESULT_SCHEMA, INTERRUPTED_OUTPUT };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON round-trip: drops undefined/functions, so the value is a real JsonValue. */
export const toJson = (v: unknown): JsonValue => (v === undefined ? null : JSON.parse(JSON.stringify(v)) as JsonValue);

export function toContentBlocks(content: readonly McpContent[] | undefined): ContentBlock[] {
  return (content ?? []).map((c): ContentBlock =>
    c.type === 'text' && typeof c.text === 'string' ? { type: 'text', text: c.text }
      : c.type === 'image' && typeof c['data'] === 'string' && typeof c['mimeType'] === 'string'
        ? { type: 'image', data: c['data'], mimeType: c['mimeType'] }
        : { type: 'text', text: JSON.stringify(c) });
}

export function outcomeToResult(outcome: CallOutcome<McpCallToolResult>): HostToolResult {
  if (outcome.status === 'interrupted') {
    return {
      output: [{ type: 'text', text: INTERRUPTED_OUTPUT }],
      isError: true,
      details: toJson({ status: 'interrupted', ...(outcome.classification ? { classification: outcome.classification } : {}) }),
    };
  }
  const result: McpCallToolResult = isRecord(outcome.result) ? outcome.result : { content: [] };
  const { _meta: _ignored, ...rest } = result;
  const output = toContentBlocks(result.content);
  if (output.length === 0 && result.structuredContent !== undefined)
    output.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  return {
    output,
    ...(result.isError === true ? { isError: true } : {}),
    structuredOutput: toJson({ content: [], ...rest }),
  };
}

const CANCELLED_CAP = 1024;

const describe = (r: ToolIntent): RequestIntent => ({ method: r.method, server: r.server, name: r.name, digest: r.digest, requestId: r.requestId });

/**
 * Builds the single registration used by both feature actions and direct host calls.
 * Intent (identity + args digest, never args) is committed before invoke; the outcome before
 * returning. Completed calls replay from the store; a different digest for the same call id
 * throws; an unfinished write after restart surfaces as an interrupted result unless replay is allowed.
 */
export function registerOperation(spec: OperationSpec, deps: OperationDeps): HostToolRegistration {
  const calls = new DurableCalls<ToolIntent, McpCallToolResult>({ store: deps.store, mutex: deps.mutex });
  const newId = (): string => deps.newRequestId?.() ?? crypto.randomUUID();
  const replay = spec.override ? spec.override === 'replay' : spec.readOnly === true;
  const cancelled = new Set<string>();
  const active = new Map<string, AbortController>();
  const exposure = spec.exposure ?? 'direct';
  return {
    name: spec.name,
    description: spec.description ?? `${spec.wireName} on ${spec.serverId}`,
    parameters: spec.inputSchema,
    replay: replay ? 'safe' : 'unsafe',
    structuredOutputSchema: CALL_TOOL_RESULT_SCHEMA,
    ...(exposure === 'codemode' ? { callers: ['tools'] as const } : {}),
    ...(exposure === 'direct' ? { callers: ['model', 'tools'] as const } : {}),
    ...(exposure === 'deferred' ? { deferred: true as const } : {}),
    async execute(rawArgs, api, context) {
      // The harness validates against `parameters`, but those are arbitrary JSON Schema; the engine needs an object.
      if (!isRecord(rawArgs)) throw new TypeError(`${spec.name}: arguments must be a JSON object`);
      const args: Readonly<Record<string, unknown>> = rawArgs;
      const key = nestedCallKey(api.callId, { key: 'mcp' });
      const effective = applyIdempotencyPolicy(
        { serverId: spec.serverId, toolName: spec.wireName, inputSchema: spec.inputSchema, args, logicalKey: key },
        deps.policies,
      );
      const digest = argsDigest(effective);
      const intent: ToolIntent = { method: 'tools/call', server: spec.serverId, name: spec.wireName, durableId: key, digest, requestId: newId() };
      // Per-call controller, live only while this execute runs, so cancel() can abort it.
      const ctrl = new AbortController();
      active.set(api.callId, ctrl);
      const signal = AbortSignal.any([ctrl.signal, ...[context.abortSignal, context.signal].filter((s) => s !== undefined)]);
      try {
        const outcome = await calls.execute(key, intent, (sent) => spec.invoke(effective, signal, sent.requestId), {
          tool: spec.wireName,
          describe,
          restartRequest: (r) => ({ ...r, requestId: newId() }),
          ...(deps.acceptDuplicate !== undefined ? { acceptDuplicate: deps.acceptDuplicate } : {}),
          ...(deps.restartLimit !== undefined ? { restartLimit: deps.restartLimit } : {}),
          ...(spec.readOnly ? { readOnlyTools: [spec.wireName] } : {}),
          ...(spec.override ? { toolOverrides: { [spec.wireName]: spec.override } } : {}),
        });
        return outcomeToResult(outcome);
      } finally {
        if (active.get(api.callId) === ctrl) active.delete(api.callId);
      }
    },
    async cancel(_args, api) {
      // Never invokes or nests. Always aborts an executing call; onCancel (remote task hooks) runs once per call id.
      active.get(api.callId)?.abort();
      if (cancelled.has(api.callId)) return;
      cancelled.add(api.callId);
      // ## YAGNI: bounded FIFO dedupe instead of tracking call lifetimes; an id evicted after
      // CANCELLED_CAP newer cancels may fire onCancel again, which hooks must tolerate anyway.
      if (cancelled.size > CANCELLED_CAP) cancelled.delete(cancelled.values().next().value!);
      await deps.onCancel?.({ callId: api.callId, name: spec.name, ...(api.checkpoint !== undefined ? { checkpoint: api.checkpoint } : {}) });
    },
  };
}
