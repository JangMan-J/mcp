import type {
  Exchange,
  JsonRpcNotification,
  JsonRpcRequest,
  TelemetryPort,
  TelemetrySpan,
  Transport,
  TransportCall,
  W3cTraceContext,
} from "@mcp-client/core";
import { validateTraceContext } from "@mcp-client/core";

export const OtelSpanKind = {
  INTERNAL: 0,
  SERVER: 1,
  CLIENT: 2,
  PRODUCER: 3,
  CONSUMER: 4,
} as const;
export type OtelSpanKindValue = (typeof OtelSpanKind)[keyof typeof OtelSpanKind];

export const OtelSpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type OtelSpanStatusCodeValue = (typeof OtelSpanStatusCode)[keyof typeof OtelSpanStatusCode];

export type OtelAttributeValue = string | number | boolean;

export interface OtelSpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState?: string;
}

export interface OtelSpan {
  setAttribute(key: string, value: OtelAttributeValue): void;
  recordException(exception: unknown): void;
  setStatus(status: { readonly code: OtelSpanStatusCodeValue; readonly message?: string }): void;
  end(): void;
}

export interface OtelTracer {
  startSpan(
    name: string,
    options?: {
      readonly kind?: OtelSpanKindValue;
      readonly attributes?: Record<string, OtelAttributeValue>;
    },
  ): OtelSpan;
}

export interface OtelContextSource {
  activeSpanContext(): OtelSpanContext | undefined;
  activeBaggage?(): string | undefined;
}

const SECRET_KEY_RE =
  /(?:^|\.)(?:token|access_token|refresh_token|id_token|client_secret|secret|password|passwd|assertion|client_assertion|authorization|auth|cookie|set-cookie|api_key|apikey)$/i;
const CONTENT_KEY_RE =
  /(?:^|\.)(?:arguments|args|input|inputs|params|result|results|output|outputs|content|requestState|request_state|body|payload|text|prompt|completion|messages)$/i;
const CREDENTIAL_URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/g;
const QUERY_SECRET_RE = /([?&](?:access_token|refresh_token|id_token|client_secret|assertion|client_assertion|token|secret|password)=)[^&\s#]+/gi;
const BEARER_RE = /\b(Bearer|Basic|DPoP)\s+[A-Za-z0-9\-._~+/]+=*/gi;

export function sanitizeSecretString(value: string): string {
  return value
    .replace(CREDENTIAL_URL_RE, (m) => m.replace(/:\/\/[^@]+@/, "://[REDACTED]@"))
    .replace(QUERY_SECRET_RE, "$1[REDACTED]")
    .replace(BEARER_RE, "$1 [REDACTED]");
}

function isBlockedAttributeKey(key: string, captureContent: boolean): boolean {
  if (key === "mcp.session.id") return true;
  if (SECRET_KEY_RE.test(key)) return true;
  if (!captureContent && CONTENT_KEY_RE.test(key)) return true;
  return false;
}

function sanitizeAttributeValue(
  key: string,
  value: OtelAttributeValue,
  captureContent: boolean,
): OtelAttributeValue | undefined {
  if (isBlockedAttributeKey(key, captureContent)) return undefined;
  if (typeof value !== "string") return value;
  const sanitized = sanitizeSecretString(value);
  if (!captureContent && /(?:requestState|authorization|client_secret|access_token|assertion)/i.test(sanitized)) {
    return "[REDACTED]";
  }
  return sanitized;
}

function sanitizeException(err: unknown, captureContent: boolean): Error {
  const raw = err instanceof Error ? err.message : String(err);
  let msg = sanitizeSecretString(raw);
  if (!captureContent) {
    msg = msg.replace(/(?:arguments|result|requestState|authorization|token|secret|assertion)\s*[:=]\s*\S+/gi, "[REDACTED]");
  }
  const out = new Error(msg);
  if (err instanceof Error) out.name = err.name;
  return out;
}

export function mapNetworkTransport(binding: string): "pipe" | "tcp" | string {
  if (binding === "stdio") return "pipe";
  if (binding === "streamable-http") return "tcp";
  return binding;
}

function countListMembers(value: string): number {
  return value.split(",").filter((part) => part.trim().length > 0).length;
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export interface OtelTelemetryOptions {
  readonly tracer: OtelTracer;
  readonly contextSource?: OtelContextSource;
  readonly captureContent?: boolean;
  readonly onDiagnostic?: (diagnostic: string) => void;
}

export class OtelTelemetryPort implements TelemetryPort {
  private readonly tracer: OtelTracer;
  private readonly contextSource: OtelContextSource | undefined;
  readonly captureContent: boolean;
  private readonly onDiagnostic: ((diagnostic: string) => void) | undefined;

  constructor(opts: OtelTelemetryOptions) {
    this.tracer = opts.tracer;
    this.contextSource = opts.contextSource;
    this.captureContent = opts.captureContent === true;
    this.onDiagnostic = opts.onDiagnostic;
  }

  activeContext(): W3cTraceContext | undefined {
    const spanCtx = this.contextSource?.activeSpanContext();
    if (!spanCtx) return undefined;

    const flagsHex = (spanCtx.traceFlags & 0xff).toString(16).padStart(2, "0");
    const traceparent = `00-${spanCtx.traceId}-${spanCtx.spanId}-${flagsHex}`;

    let tracestate = spanCtx.traceState;
    if (tracestate !== undefined) {
      if (tracestate.length > 512 || countListMembers(tracestate) > 32) {
        this.onDiagnostic?.("tracestate-truncated-or-dropped");
        tracestate = undefined;
      }
    }

    let baggage = this.contextSource?.activeBaggage?.();
    if (baggage !== undefined) {
      if (utf8ByteLength(baggage) > 8192 || countListMembers(baggage) > 64) {
        this.onDiagnostic?.("baggage-dropped");
        baggage = undefined;
      }
    }

    const candidate: W3cTraceContext = {
      traceparent,
      ...(tracestate !== undefined ? { tracestate } : {}),
      ...(baggage !== undefined ? { baggage } : {}),
    };
    const checked = validateTraceContext(candidate);
    for (const d of checked.diagnostics) {
      this.onDiagnostic?.(d);
    }
    return checked.valid;
  }

  startClientSpan(name: string, attrs: Record<string, OtelAttributeValue>): TelemetrySpan {
    const filtered: Record<string, OtelAttributeValue> = {};
    for (const [k, v] of Object.entries(attrs)) {
      const sv = sanitizeAttributeValue(k, v, this.captureContent);
      if (sv !== undefined) filtered[k] = sv;
    }
    const otelSpan = this.tracer.startSpan(name, {
      kind: OtelSpanKind.CLIENT,
      attributes: filtered,
    });
    const captureContent = this.captureContent;
    return {
      setAttribute(key, value) {
        const sv = sanitizeAttributeValue(key, value, captureContent);
        if (sv !== undefined) otelSpan.setAttribute(key, sv);
      },
      recordException(err) {
        otelSpan.recordException(sanitizeException(err, captureContent));
      },
      end(status) {
        otelSpan.setStatus(
          status.ok
            ? { code: OtelSpanStatusCode.OK }
            : {
                code: OtelSpanStatusCode.ERROR,
                ...(status.errorKind !== undefined ? { message: status.errorKind } : {}),
              },
        );
        otelSpan.end();
      },
    };
  }
}

export function createOtelTelemetry(opts: OtelTelemetryOptions): OtelTelemetryPort {
  return new OtelTelemetryPort(opts);
}

export interface InstrumentOptions {
  readonly protocolVersion?: string;
  readonly spanName?: (method: string) => string;
}

export function instrumentTransport(
  transport: Transport,
  telemetry: TelemetryPort,
  opts?: InstrumentOptions,
): Transport {
  return {
    binding: transport.binding,
    diagnostics: transport.diagnostics,
    notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void> {
      return transport.notify(msg, ctx);
    },
    close(closeOpts?: { readonly graceMs?: number }): Promise<void> {
      return transport.close(closeOpts);
    },
    start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
      const spanName = opts?.spanName ? opts.spanName(msg.method) : `mcp.client ${msg.method}`;
      const attrs: Record<string, OtelAttributeValue> = {
        "mcp.method.name": msg.method,
        "network.transport": mapNetworkTransport(transport.binding),
        ...(opts?.protocolVersion !== undefined ? { "mcp.protocol.version": opts.protocolVersion } : {}),
      };
      const span = telemetry.startClientSpan(spanName, attrs);
      const inner = transport.start(msg, ctx);
      const done = inner.done.then(
        (end) => {
          if (end.kind === "response") {
            if ("error" in end.message) {
              span.setAttribute("mcp.outcome.kind", "jsonrpc-error");
              span.end({ ok: false, errorKind: "jsonrpc-error" });
            } else {
              span.setAttribute("mcp.outcome.kind", "ok");
              span.end({ ok: true });
            }
          } else {
            span.setAttribute("mcp.outcome.kind", end.failure.kind);
            span.recordException(new Error(end.failure.message));
            span.end({ ok: false, errorKind: end.failure.kind });
          }
          return end;
        },
        (err) => {
          span.setAttribute("mcp.outcome.kind", "transport-error");
          span.recordException(err);
          span.end({ ok: false, errorKind: "transport-error" });
          throw err;
        },
      );
      return {
        ...(inner.abortDelivery ? { abortDelivery: () => inner.abortDelivery!() } : {}),
        notifications: inner.notifications,
        done,
      };
    },
  };
}
