/**
 * SSE wire helpers for transport-http tests.
 * Pure string/byte encoders following the WHATWG SSE grammar.
 */

export interface SseEventInput {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export function formatSseEvent(input: SseEventInput): string {
  let out = "";
  if (input.event) out += `event: ${input.event}\n`;
  if (input.id !== undefined) out += `id: ${input.id}\n`;
  if (input.retry !== undefined) out += `retry: ${input.retry}\n`;
  for (const line of input.data.split("\n")) {
    out += `data: ${line}\n`;
  }
  out += "\n";
  return out;
}

export function formatSseComment(text = "keep-alive"): string {
  return `: ${text}\n\n`;
}

export function formatSseJson(
  message: unknown,
  opts?: { readonly event?: string; readonly id?: string; readonly retry?: number },
): string {
  return formatSseEvent({
    data: JSON.stringify(message),
    ...(opts?.event ? { event: opts.event } : {}),
    ...(opts?.id !== undefined ? { id: opts.id } : {}),
    ...(opts?.retry !== undefined ? { retry: opts.retry } : {}),
  });
}
