export interface W3cTraceContext {
  readonly traceparent: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

export interface TelemetrySpan {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  end(status: { ok: boolean; errorKind?: string }): void;
}

export interface TelemetryPort {
  activeContext(): W3cTraceContext | undefined;
  startClientSpan(name: string, attrs: Record<string, string | number | boolean>): TelemetrySpan;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ALL_ZERO_TRACE = "00000000000000000000000000000000";
const ALL_ZERO_SPAN = "0000000000000000";

export function validateTraceContext(
  ctx: W3cTraceContext,
): { valid: W3cTraceContext; diagnostics: string[] } | { valid: undefined; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const m = TRACEPARENT_RE.exec(ctx.traceparent);
  if (!m || m[1] === ALL_ZERO_TRACE || m[2] === ALL_ZERO_SPAN) {
    diagnostics.push("invalid-traceparent");
    return { valid: undefined, diagnostics };
  }
  let tracestate: string | undefined = ctx.tracestate;
  if (tracestate !== undefined && tracestate.length > 512) {
    diagnostics.push("tracestate-truncated-or-dropped");
    tracestate = undefined;
  }
  let baggage: string | undefined = ctx.baggage;
  if (baggage !== undefined && baggage.length > 8192) {
    diagnostics.push("baggage-dropped");
    baggage = undefined;
  }
  return {
    valid: {
      traceparent: ctx.traceparent,
      ...(tracestate !== undefined ? { tracestate } : {}),
      ...(baggage !== undefined ? { baggage } : {}),
    },
    diagnostics,
  };
}

export const noopTelemetry: TelemetryPort = {
  activeContext: () => undefined,
  startClientSpan: () => ({
    setAttribute() {},
    recordException() {},
    end() {},
  }),
};
