import { createHash } from 'node:crypto';
import { DurableToolAdapter, type ToolWire } from './adapter.js';
import type { CallOutcome, DurableCallStore, PerKeyMutex, UncertainWrite } from './calls.js';
import type { ToolIntent } from './adapter.js';
import type { IdempotencyPolicy } from './policies.js';

// Structural mirror of pi-durable's harness types (packages/durable/src/harness/types.ts).
// Nothing here imports Pi; the shapes are matched structurally.

export interface DurableContext { readonly signal?: AbortSignal }
export interface DurableNestedCallOptions { readonly key?: string; readonly progress?: boolean; readonly wait?: boolean }
export interface DurableToolExecutionApi<TDetails = unknown, C = unknown> {
  readonly callId: string;
  readonly checkpoint?: C;
  readonly wake?: unknown;
  executeTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    context: DurableContext,
    options?: DurableNestedCallOptions,
  ): Promise<unknown>;
}
export interface DurableToolResult<TDetails = unknown> {
  readonly output: string;
  readonly isError?: boolean;
  readonly details?: TDetails;
  readonly structuredOutput?: unknown;
}
export interface DurableToolRegistration<TDetails = unknown, C = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly replay?: 'safe' | 'unsafe';
  readonly executionMode?: 'sequential' | 'parallel';
  readonly structuredOutputSchema?: Record<string, unknown>;
  readonly callers?: readonly ('model' | 'tools')[];
  readonly deferred?: true;
  execute(
    args: Readonly<Record<string, unknown>>,
    api: DurableToolExecutionApi<TDetails, C>,
    context: DurableContext,
  ): Promise<DurableToolResult<TDetails>>;
  cancel?(
    args: Readonly<Record<string, unknown>>,
    api: DurableToolExecutionApi<TDetails, C>,
    context: DurableContext,
  ): Promise<void>;
}
export interface DurablePromptSection {
  readonly key: string;
  readonly tag?: boolean;
  render(): string | undefined | Promise<string | undefined>;
}
export interface DurableExtension {
  readonly name: string;
  readonly namespace?: { readonly name: string; readonly description: string; readonly instructions?: string };
  readonly tools?: readonly DurableToolRegistration[];
  readonly sections?: readonly DurablePromptSection[];
}

// MCP side.

export type Exposure = 'direct' | 'codemode' | 'deferred' | 'hidden';
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}
export interface McpContent { readonly type: string; readonly text?: string; readonly [k: string]: unknown }
export interface McpCallToolResult {
  readonly content?: readonly McpContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
  readonly [k: string]: unknown;
}

export interface DurableMcpExtensionOptions {
  readonly serverId: string;
  readonly description: string;
  readonly instructions?: string;
  readonly exposure?: Exposure;
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  readonly tools: readonly McpToolDescriptor[];
  readonly readOnlyTools?: readonly string[];
  readonly toolOverrides?: Readonly<Record<string, 'replay' | 'interrupt'>>;
  /**
   * Operator opt-in to resend an interrupted write after a host restart.
   * Local checkpoints cannot prove whether a remote side effect happened, so
   * enabling this explicitly accepts that the server may see the call twice.
   */
  readonly acceptDuplicate?: boolean;
  readonly restartLimit?: number;
  readonly onCancel?: (info: { callId: string; toolName: string; checkpoint?: unknown }) => void | Promise<void>;
  /** Durable storage for call intent/outcome records. */
  readonly store: DurableCallStore<ToolIntent, McpCallToolResult>;
  readonly mutex: PerKeyMutex;
  /** Injected MCP `tools/call` transport. */
  readonly send: (request: ToolWire) => Promise<McpCallToolResult>;
  readonly policies?: readonly IdempotencyPolicy[];
  readonly newRequestId?: () => string;
}

export const INTERRUPTED_OUTPUT =
  'Uncertain write: the MCP call was interrupted across a host restart and may or may not have run; do not retry blindly.';

/** JSON schema of the `_meta`-stripped MCP CallToolResult handed to programs as structuredOutput. */
export const CALL_TOOL_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    content: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' } }, required: ['type'] } },
    structuredContent: {},
    isError: { type: 'boolean' },
  },
  required: ['content'],
};

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const hash8 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 8);

/** Deterministic `mcp__<server>__<tool>` names; hash-suffixed when invalid, too long, ambiguous or colliding. */
export function durableToolNames(serverId: string, toolNames: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const hashed = (tool: string): string => {
    const base = `mcp__${serverId}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 55);
    return `${base}_${hash8(`${serverId}\0${tool}`)}`;
  };
  const ambiguousServer = serverId.includes('__');
  // First pass: names that are valid as-is.
  for (const tool of toolNames) {
    const raw = `mcp__${serverId}__${tool}`;
    if (!ambiguousServer && NAME_RE.test(raw) && !used.has(raw)) { out.set(tool, raw); used.add(raw); }
  }
  for (const tool of toolNames) {
    if (out.has(tool)) continue;
    let name = hashed(tool);
    for (let i = 1; used.has(name); i++) name = `${name.slice(0, 55)}_${hash8(`${serverId}\0${tool}\0${i}`)}`;
    out.set(tool, name);
    used.add(name);
  }
  return out;
}

export function resolveExposure(options: Pick<DurableMcpExtensionOptions, 'exposure' | 'toolExposure'>, tool: string): Exposure {
  const map = options.toolExposure;
  if (map && Object.hasOwn(map, tool)) return map[tool] as Exposure;
  if (map && Object.hasOwn(map, '*')) return map['*'] as Exposure;
  return options.exposure ?? 'direct';
}

/** MCP tools/call is unsafe to replay unless the operator says otherwise. */
export function replayPolicy(
  options: Pick<DurableMcpExtensionOptions, 'readOnlyTools' | 'toolOverrides'>,
  tool: string,
): 'safe' | 'unsafe' {
  const override = options.toolOverrides?.[tool];
  if (override === 'replay') return 'safe';
  if (override !== 'interrupt' && options.readOnlyTools?.includes(tool) === true) return 'safe';
  return 'unsafe';
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stripMeta(result: McpCallToolResult): McpCallToolResult {
  const { _meta: _ignored, ...rest } = result;
  return rest;
}

function modelText(result: McpCallToolResult): string {
  const parts: string[] = [];
  for (const c of result.content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else parts.push(`[${c.type} content]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n');
}

const resultIsError = (r: unknown): boolean =>
  isRecord(r) && (r['isError'] === true || r['kind'] === 'tool-isError' || r['status'] === 'tool-isError');

export function outcomeToResult(outcome: CallOutcome<McpCallToolResult>): DurableToolResult {
  if (outcome.status === 'interrupted') {
    const classification: UncertainWrite | undefined = outcome.classification;
    return {
      output: INTERRUPTED_OUTPUT,
      isError: true,
      details: { status: 'interrupted', ...(classification ? { classification } : {}) },
    };
  }
  const result = isRecord(outcome.result) ? outcome.result : ({ content: [] } as McpCallToolResult);
  const structuredOutput = stripMeta(result);
  return {
    output: modelText(result),
    ...(resultIsError(result) ? { isError: true } : {}),
    structuredOutput,
  };
}

/**
 * Wraps one MCP server as a pi-durable Extension.
 *
 * Each call commits its intent before sending and its outcome before waking the
 * caller; completed results replay from storage without resending. A local
 * checkpoint cannot prove whether a remote side effect happened: an interrupted
 * write surfaces as an uncertain-write error rather than being resent, and a
 * duplicate send is possible only when the operator sets `acceptDuplicate` or a
 * per-tool `"replay"` override.
 */
export function createDurableMcpExtension(options: DurableMcpExtensionOptions): DurableExtension {
  const adapter = new DurableToolAdapter<McpCallToolResult>({
    store: options.store,
    mutex: options.mutex,
    send: options.send,
    ...(options.policies ? { policies: options.policies } : {}),
    ...(options.newRequestId ? { newRequestId: options.newRequestId } : {}),
    restart: {
      ...(options.acceptDuplicate !== undefined ? { acceptDuplicate: options.acceptDuplicate } : {}),
      ...(options.restartLimit !== undefined ? { restartLimit: options.restartLimit } : {}),
      ...(options.readOnlyTools ? { readOnlyTools: options.readOnlyTools } : {}),
      ...(options.toolOverrides ? { toolOverrides: options.toolOverrides } : {}),
    },
  });
  const names = durableToolNames(options.serverId, options.tools.map(t => t.name));
  const cancelled = new Set<string>();
  const visible: { tool: McpToolDescriptor; name: string; exposure: Exposure }[] = [];
  for (const tool of options.tools) {
    const exposure = resolveExposure(options, tool.name);
    if (exposure !== 'hidden') visible.push({ tool, name: names.get(tool.name) as string, exposure });
  }

  const tools: DurableToolRegistration[] = visible.map(({ tool, name, exposure }) => ({
    name,
    description: tool.description ?? `MCP tool ${tool.name} on ${options.serverId}`,
    parameters: tool.inputSchema,
    replay: replayPolicy(options, tool.name),
    structuredOutputSchema: CALL_TOOL_RESULT_SCHEMA,
    ...(exposure === 'codemode' ? { callers: ['tools'] as const } : {}),
    ...(exposure === 'direct' ? { callers: ['model', 'tools'] as const } : {}),
    ...(exposure === 'deferred' ? { deferred: true as const } : {}),
    async execute(args, api) {
      const outcome = await adapter.callTool(api.callId, { key: 'mcp' }, {
        serverId: options.serverId, toolName: tool.name, inputSchema: tool.inputSchema, args,
      });
      return outcomeToResult(outcome);
    },
    async cancel(_args, api) {
      // Idempotent: a parked call may be cancelled more than once. Never sends or nests.
      if (cancelled.has(api.callId)) return;
      cancelled.add(api.callId);
      await options.onCancel?.({
        callId: api.callId,
        toolName: tool.name,
        ...(api.checkpoint !== undefined ? { checkpoint: api.checkpoint } : {}),
      });
    },
  }));

  const sections: DurablePromptSection[] = visible.length === 0 ? [] : [{
    key: 'mcp_servers',
    render: () => {
      const lines = [`MCP server ${options.serverId}: ${options.description}`];
      if (options.instructions) lines.push(options.instructions);
      for (const v of visible) lines.push(`- ${v.name} (${v.exposure})${v.tool.description ? `: ${v.tool.description}` : ''}`);
      return lines.join('\n');
    },
  }];

  return {
    name: `mcp-${options.serverId}`,
    namespace: {
      name: options.serverId,
      description: options.description,
      ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    },
    tools,
    sections,
  };
}

/** Explicit keys must never collide with positional keys `1`, `2`, ... */
export function validateDurableNestedKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('Nested call key must be a non-empty string');
  if (key.includes('/')) throw new TypeError('Nested call key must not contain "/"');
  if (key === '__proto__') throw new TypeError('Nested call key must not be "__proto__"');
  if (/^[1-9]\d*$/.test(key)) throw new TypeError('Nested call key must not be a positive integer');
}

export function executeNestedMcpTool(
  api: Pick<DurableToolExecutionApi, 'executeTool' | 'wake'>,
  name: string,
  args: Readonly<Record<string, unknown>>,
  context: DurableContext,
  options?: DurableNestedCallOptions,
): Promise<unknown> {
  if (api.wake !== undefined && options?.key === undefined)
    throw new Error('After a wake, nested MCP tool calls require an explicit key');
  if (options?.key !== undefined) validateDurableNestedKey(options.key);
  return api.executeTool(name, args, context, options);
}
