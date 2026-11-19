import type {
  Exchange,
  JsonRpcNotification,
  JsonRpcRequest,
  Transport,
  TransportCall,
  TransportDiagnostic,
} from "@mcp-client/core";
import { McpClient } from "@mcp-client/core";
import {
  createOtelTelemetry,
  instrumentTransport,
  mapNetworkTransport,
  RecordingTracer,
  type OtelContextSource,
} from "./index.js";

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const KNOWN_MUTANTS = new Set([
  "prefixed-meta-keys",
  "http-traceparent-header",
  "fabricate-traceparent",
  "skip-w3c-bounds",
  "default-capture-content-true",
  "leak-secret-in-exception",
  "emit-session-id",
  "quic-transport",
  "span-per-progress",
  "span-per-diagnostic",
]);

export function supportsMutant(name: string): boolean {
  return KNOWN_MUTANTS.has(name);
}

interface TelFixture {
  readonly id: string;
  readonly tier: string;
  readonly requirements: readonly string[];
  readonly script: readonly Record<string, unknown>[];
  readonly expect: Record<string, unknown>;
}

function assertFixture(raw: unknown): TelFixture {
  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid fixture: expected object");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== "string" || !Array.isArray(obj.script) || !obj.expect || typeof obj.expect !== "object") {
    throw new Error(`Invalid fixture shape: ${String(obj.id)}`);
  }
  return obj as unknown as TelFixture;
}

export interface ObservedFrame {
  direction: "client" | "server";
  endpoint?: "mcp";
  method?: string;
  url?: string;
  message: unknown;
}
export interface ExchangeObservation {
  frames: ObservedFrame[];
  mcpEndpoint?: string;
  zeroWire?: boolean;
}

const MCP_URL = "http://127.0.0.1/mcp";
const loopback = <T>(v: T): T =>
  JSON.parse(JSON.stringify(v).replace(/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.test)(?![A-Za-z0-9.-])/gu, "$1.localhost")) as T;

function createMemoryTransport(opts: {
  frames?: ObservedFrame[];
  binding: "stdio" | "streamable-http";
  onStart?: (msg: JsonRpcRequest, ctx: TransportCall) => void;
  notifications?: readonly JsonRpcNotification[];
  diagnostics?: readonly TransportDiagnostic[];
  httpHeaders?: Record<string, string>;
}): Transport {
  const diags = opts.diagnostics ?? [];
  return {
    binding: opts.binding,
    diagnostics: {
      async *[Symbol.asyncIterator]() {
        for (const d of diags) yield d;
      },
    },
    async notify() {},
    async close() {},
    start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
      opts.onStart?.(msg, ctx);
      const notifs = opts.notifications ?? [];
      const http = opts.binding === "streamable-http";
      const wire = (direction: "client" | "server", message: unknown): ObservedFrame =>
        loopback({ direction, ...(http ? { endpoint: "mcp" as const, ...(direction === "client" ? { method: "POST", url: MCP_URL } : {}) } : {}), message });
      opts.frames?.push(wire("client", msg));
      return {
        notifications: {
          async *[Symbol.asyncIterator]() {
            for (const n of notifs) {
              opts.frames?.push(wire("server", n));
              yield n;
            }
          },
        },
        done: Promise.resolve({
          kind: "response" as const,
          message: { jsonrpc: "2.0" as const, id: msg.id, result: { ok: true } },
        }).then((r) => {
          opts.frames?.push(wire("server", r.message));
          return r;
        }),
      };
    },
  };
}

async function runTraceContextScenario(frames: ObservedFrame[], mutant?: string): Promise<void> {
  const tracer = new RecordingTracer();
  const capturedRequests: JsonRpcRequest[] = [];
  const capturedHeaders: Record<string, string> = {};
  const diagnostics: string[] = [];

  const validCtx: OtelContextSource = {
    activeSpanContext: () => ({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
      traceState: "congo=t61rcWkgMzE",
    }),
    activeBaggage: () => "userId=alice",
  };

  const telemetry = createOtelTelemetry({
    tracer,
    contextSource: validCtx,
    onDiagnostic: (d) => diagnostics.push(d),
  });

  const transport = createMemoryTransport({
    frames,
    binding: "streamable-http",
    onStart: (msg) => {
      if (mutant === "prefixed-meta-keys" && msg.params && typeof msg.params === "object") {
        const meta = (msg.params as Record<string, unknown>)._meta as Record<string, unknown> | undefined;
        if (meta && typeof meta.traceparent === "string") {
          meta["otel.traceparent"] = meta.traceparent;
          delete meta.traceparent;
        }
      }
      if (mutant === "http-traceparent-header") {
        capturedHeaders.traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
      }
      capturedRequests.push(msg);
    },
  });

  const client = new McpClient({
    transport,
    server: { key: "tel-ctx" },
    ports: { telemetry },
  });

  await client.request("tools/list", {});
  const firstMeta = (capturedRequests[0]?.params as Record<string, unknown> | undefined)?._meta as
    | Record<string, unknown>
    | undefined;

  if (!firstMeta || firstMeta.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01") {
    throw new ObservationMismatch("Expected unprefixed _meta.traceparent to be propagated");
  }
  if (firstMeta.tracestate !== "congo=t61rcWkgMzE" || firstMeta.baggage !== "userId=alice") {
    throw new ObservationMismatch("Expected unprefixed _meta.tracestate and _meta.baggage");
  }
  if ("traceparent" in capturedHeaders) {
    throw new ObservationMismatch("Expected no HTTP traceparent header");
  }

  // TEL-CTX-3: absent host context -> never fabricate
  const emptyTelemetry = createOtelTelemetry({ tracer });
  const absentCtx =
    mutant === "fabricate-traceparent"
      ? { traceparent: "00-11111111111111111111111111111111-1111111111111111-01" }
      : emptyTelemetry.activeContext();
  if (absentCtx !== undefined) {
    throw new ObservationMismatch("Expected undefined activeContext when host supplies none");
  }

  // TEL-CTX-2: oversized tracestate / baggage bounds
  const oversizedTelemetry = createOtelTelemetry({
    tracer,
    contextSource: {
      activeSpanContext: () => ({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
        traceState: Array.from({ length: 33 }, (_, i) => `k${i}=v${i}`).join(","),
      }),
      activeBaggage: () => "a=" + "x".repeat(8200),
    },
    onDiagnostic: (d) => diagnostics.push(d),
  });
  const bounded =
    mutant === "skip-w3c-bounds"
      ? { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "k0=v0", baggage: "a=x" }
      : oversizedTelemetry.activeContext();
  if (!bounded || bounded.tracestate !== undefined || bounded.baggage !== undefined) {
    throw new ObservationMismatch("Expected oversized tracestate and baggage to be dropped");
  }
  if (diagnostics.length < 2) {
    throw new ObservationMismatch("Expected diagnostics for dropped oversized tracestate/baggage");
  }
}

async function runPrivacyScenario(mutant?: string): Promise<void> {
  const tracer = new RecordingTracer();
  const telemetry = createOtelTelemetry({
    tracer,
    ...(mutant === "default-capture-content-true" ? { captureContent: true } : {}),
  });

  if (telemetry.captureContent !== false) {
    throw new ObservationMismatch("Expected captureContent to default strictly to false");
  }

  const span = telemetry.startClientSpan("mcp.client tools/call", {
    "mcp.method.name": "tools/call",
    "mcp.tool.arguments": '{"secret":"pw"}',
    "mcp.tool.result": "secret-output",
    requestState: "state-123",
    authorization: "Bearer eyJhbGciOiJIUzI1NiJ9",
    "url.full": "https://alice:hunter2@example.com/cb?access_token=tok123&client_secret=cs123&assertion=asrt123",
  });

  const rawErr = new Error(
    "failed at https://alice:hunter2@example.com/cb?access_token=tok123&client_secret=cs123&assertion=asrt123",
  );
  if (mutant === "leak-secret-in-exception") {
    tracer.spans[0]!.recordException(rawErr);
  } else {
    span.recordException(rawErr);
  }
  span.end({ ok: false, errorKind: "transport" });

  const recorded = tracer.spans[0]!;
  for (const forbidden of ["mcp.tool.arguments", "mcp.tool.result", "requestState", "authorization"]) {
    if (forbidden in recorded.attributes) {
      throw new ObservationMismatch(`Forbidden attribute leaked: ${forbidden}`);
    }
  }
  const urlAttr = String(recorded.attributes["url.full"] ?? "");
  if (urlAttr.includes("hunter2") || urlAttr.includes("tok123") || urlAttr.includes("cs123") || urlAttr.includes("asrt123")) {
    throw new ObservationMismatch("Credential URL secrets leaked into span attributes");
  }
  const excText = String((recorded.exceptions[0] as Error | undefined)?.message ?? "");
  if (excText.includes("hunter2") || excText.includes("tok123") || excText.includes("cs123") || excText.includes("asrt123")) {
    throw new ObservationMismatch("Credential URL secrets leaked into recorded exception");
  }
}

async function runAttributesScenario(frames: ObservedFrame[], mutant?: string): Promise<void> {
  const tracer = new RecordingTracer();
  const telemetry = createOtelTelemetry({ tracer });

  const baseTransport = createMemoryTransport({ binding: "streamable-http" });
  const instrumented = instrumentTransport(baseTransport, telemetry, { protocolVersion: "2025-11-25" });

  const ac = new AbortController();
  const ex = instrumented.start(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
    { signal: ac.signal, idempotent: false, timeoutMs: 1000 },
  );
  await ex.done;

  const span = tracer.spans[0]!;
  if (mutant === "emit-session-id") {
    span.setAttribute("mcp.session.id", "sess-123");
  }
  if (mutant === "quic-transport") {
    span.setAttribute("network.transport", "quic");
  }

  if (span.attributes["mcp.session.id"] !== undefined) {
    throw new ObservationMismatch("mcp.session.id must never be emitted");
  }
  if (span.attributes["network.transport"] !== "tcp") {
    throw new ObservationMismatch(`Expected network.transport=tcp, got ${String(span.attributes["network.transport"])}`);
  }
  if (mapNetworkTransport("stdio") !== "pipe") {
    throw new ObservationMismatch("Expected stdio to map to pipe");
  }
  if (span.attributes["mcp.method.name"] !== "tools/call") {
    throw new ObservationMismatch("Missing mcp.method.name");
  }
  if (span.attributes["mcp.protocol.version"] !== "2025-11-25") {
    throw new ObservationMismatch("Missing mcp.protocol.version");
  }
  if (span.attributes["mcp.outcome.kind"] !== "ok") {
    throw new ObservationMismatch("Missing mcp.outcome.kind");
  }
}

async function runChannelSeparationScenario(frames: ObservedFrame[], mutant?: string): Promise<void> {
  const tracer = new RecordingTracer();
  const telemetry = createOtelTelemetry({ tracer });

  const progressNotification: JsonRpcNotification = {
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: "p1", progress: 50, total: 100 },
  };
  const diagnostic: TransportDiagnostic = {
    kind: "stderr",
    message: "server stderr line",
    atMs: 10,
  };

  const baseTransport = createMemoryTransport({
    frames,
    binding: "stdio",
    notifications: [progressNotification],
    diagnostics: [diagnostic],
  });
  const instrumented = instrumentTransport(baseTransport, telemetry);

  const ac = new AbortController();
  const ex = instrumented.start(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: {} },
    { signal: ac.signal, idempotent: false, timeoutMs: 1000 },
  );

  for await (const n of ex.notifications) {
    if (mutant === "span-per-progress" && n.method === "notifications/progress") {
      telemetry.startClientSpan("progress", { "mcp.method.name": n.method }).end({ ok: true });
    }
  }
  await ex.done;

  for await (const d of instrumented.diagnostics) {
    if (mutant === "span-per-diagnostic") {
      telemetry.startClientSpan(`diag.${d.kind}`, {}).end({ ok: true });
    }
  }

  if (tracer.spans.length !== 1) {
    throw new ObservationMismatch(`Expected exactly 1 span (no spans for progress/diagnostics), got ${tracer.spans.length}`);
  }
  if (tracer.spans[0]!.events.length !== 0) {
    throw new ObservationMismatch("Expected 0 span events from progress/diagnostics");
  }
}

export async function runExchange(fixture: unknown, mutant?: string): Promise<ExchangeObservation> {
  if (mutant !== undefined && !supportsMutant(mutant)) {
    throw new Error(`Unknown mutant: ${mutant}`);
  }
  const parsed = assertFixture(fixture);
  const frames: ObservedFrame[] = [];
  switch (parsed.id) {
    case "tel/trace-context-propagation":
      await runTraceContextScenario(frames, mutant);
      break;
    case "tel/spans-omit-content":
      await runPrivacyScenario(mutant);
      break;
    case "tel/span-attributes-no-session":
      await runAttributesScenario(frames, mutant);
      break;
    case "tel/channels-do-not-cross":
      await runChannelSeparationScenario(frames, mutant);
      break;
    default:
      throw new Error(`Unknown telemetry fixture id: ${parsed.id}`);
  }
  if (frames.length === 0) return { frames, zeroWire: true };
  const hasHttp = frames.some((f) => f.endpoint === "mcp");
  return { frames, ...(hasHttp ? { mcpEndpoint: MCP_URL } : {}) };
}
