import type { CallOutcome } from './calls.js';
import { INTERRUPTED_OUTPUT, outcomeToResult, type McpCallToolResult, type McpContent } from './extension.js';

/** pi-durable@1.6.0 ContentBlock (structural; no Pi import). */
export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string };

export interface HostToolResult {
  readonly output: ContentBlock[];
  readonly isError?: boolean;
  readonly details?: unknown;
  readonly structuredOutput?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Maps MCP content to ContentBlock[]; non-text/non-image content is rendered as JSON text. */
export function toContentBlocks(content: readonly McpContent[] | undefined): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const c of content ?? []) {
    if (c.type === 'text' && typeof c.text === 'string') out.push({ type: 'text', text: c.text });
    else if (c.type === 'image' && typeof c['data'] === 'string' && typeof c['mimeType'] === 'string')
      out.push({ type: 'image', data: c['data'], mimeType: c['mimeType'] });
    else if (c.type === 'resource' && isRecord(c['resource']) && typeof c['resource']['text'] === 'string')
      out.push({ type: 'text', text: c['resource']['text'] });
    else out.push({ type: 'text', text: JSON.stringify(c) });
  }
  return out;
}

/** Durable tools/call outcome -> real Extension result (ContentBlock[] output + structuredOutput). */
export function outcomeToHostResult(outcome: CallOutcome<McpCallToolResult>): HostToolResult {
  const base = outcomeToResult(outcome);
  if (outcome.status === 'interrupted') return { ...base, output: [{ type: 'text', text: INTERRUPTED_OUTPUT }] };
  const structured = base.structuredOutput as McpCallToolResult | undefined;
  let output = toContentBlocks(structured?.content);
  if (output.length === 0) output = [{ type: 'text', text: base.output }];
  return { ...base, output };
}

/** Wraps a feature module's raw value (prompts/resources/events/tasks/skills) as an Extension result. */
export function valueToHostResult(value: unknown): HostToolResult {
  if (isRecord(value) && Array.isArray(value['content'])) {
    const blocks = toContentBlocks(value['content'] as McpContent[]);
    return { output: blocks, structuredOutput: value, ...(value['isError'] === true ? { isError: true } : {}) };
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { output: [{ type: 'text', text }], structuredOutput: value ?? null };
}

export function errorToHostResult(err: unknown): HostToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { output: [{ type: 'text', text: message }], isError: true, details: { error: message } };
}

/** Action-style parameter schema for feature tools (mcp_prompts, mcp_events, ...). */
export const featureParameters = (actions: readonly string[]): Record<string, unknown> => ({
  type: 'object',
  properties: {
    server: { type: 'string', description: 'MCP server id' },
    action: { type: 'string', enum: [...actions] },
  },
  required: ['action'],
  additionalProperties: true,
});
