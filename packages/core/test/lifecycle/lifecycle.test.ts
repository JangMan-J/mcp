import { describe, expect, it } from "vitest";
import {
  buildUnsupportedVersionDiagnostic,
  classifyDiscoverOutcome,
  classifyJsonRpcError,
  DIAGNOSTIC_EVIDENCE_MAX,
  defaultNotificationFilter,
  EraCache,
  LIBRARY_CLIENT_INFO,
  mapLifecycleOutcome,
  McpClient,
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_LOG_LEVEL,
  META_PROTOCOL_VERSION,
  missingClientCapabilities,
  selectProtocolVersion,
  validateCallerMeta,
  type ExchangeEnd,
  type Extension,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type LifecycleContext,
  type Outcome,
  type OutcomeMeta,
  type Transport,
  type TransportCall,
} from "../../src/index.js";

const META: OutcomeMeta = { requestId: 1, method: "server/discover", binding: "stdio", attempts: 1 };
const CTX: LifecycleContext = { binding: "stdio", endpointOrCommand: "my-server --stdio", supportedVersions: ["2026-07-28"] };

function scripted(handler: (req: JsonRpcRequest, n: number) => ExchangeEnd) {
  const sent: JsonRpcRequest[] = [];
  const notificationsSent: { msg: JsonRpcNotification; ctx: TransportCall }[] = [];
  const transport: Transport = {
    binding: "stdio",
    start(req) {
      sent.push(req);
      return { notifications: { async *[Symbol.asyncIterator]() {} }, done: Promise.resolve(handler(req, sent.length)) };
    },
    async notify(msg, ctx) {
      notificationsSent.push({ msg, ctx });
    },
    async close() {},
    diagnostics: { async *[Symbol.asyncIterator]() {} },
  };
  return { transport, sent, notificationsSent };
}
const ok = (req: JsonRpcRequest, result: Record<string, unknown>): ExchangeEnd => ({
  kind: "response",
  message: { jsonrpc: "2.0", id: req.id, result },
});
const err = (req: JsonRpcRequest, code: number, message: string, data?: unknown): ExchangeEnd => ({
  kind: "response",
  message: { jsonrpc: "2.0", id: req.id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
});
const metaOf = (r: JsonRpcRequest) => r.params?.["_meta"] as Record<string, unknown>;

describe("_meta injection (WIRE-META-1..5, WIRE-LOG-1)", () => {
  it("sends protocolVersion, registry capabilities, and default clientInfo on every request", async () => {
    const { transport, sent } = scripted((req) => ok(req, {}));
    const ext: Extension = {
      id: "io.example/widgets",
      capabilities: () => ({ "io.example/widgets": { v: 1 } }),
    };
    const client = new McpClient({ transport, server: { key: "s" }, extensions: [ext] });
    await client.request("tools/list");
    await client.request("prompts/list");
    for (const r of sent) {
      expect(metaOf(r)[META_PROTOCOL_VERSION]).toBe("2026-07-28");
      expect(metaOf(r)[META_CLIENT_CAPABILITIES]).toEqual({ "io.example/widgets": { v: 1 } });
      expect(metaOf(r)[META_CLIENT_INFO]).toEqual(LIBRARY_CLIENT_INFO);
      expect(META_LOG_LEVEL in metaOf(r)).toBe(false);
    }
  });

  it("capabilities are empty when nothing is registered, and recomputed after dispose", async () => {
    const { transport, sent } = scripted((req) => ok(req, {}));
    const client = new McpClient({ transport, server: { key: "s" } });
    const d = client.use({ id: "x", capabilities: () => ({ x: {} }) });
    await client.request("tools/list");
    d.dispose();
    await client.request("tools/list");
    expect(metaOf(sent[0]!)[META_CLIENT_CAPABILITIES]).toEqual({ x: {} });
    expect(metaOf(sent[1]!)[META_CLIENT_CAPABILITIES]).toEqual({});
  });

  it("clientInfo: false omits it; an IdentityPort wins over the library default", async () => {
    const a = scripted((req) => ok(req, {}));
    await new McpClient({ transport: a.transport, server: { key: "s" }, clientInfo: false }).request("tools/list");
    expect(META_CLIENT_INFO in metaOf(a.sent[0]!)).toBe(false);
    const b = scripted((req) => ok(req, {}));
    const identity = { clientInfo: () => ({ name: "host", version: "9" }) };
    await new McpClient({ transport: b.transport, server: { key: "s" }, ports: { identity } }).request("tools/list");
    expect(metaOf(b.sent[0]!)[META_CLIENT_INFO]).toEqual({ name: "host", version: "9" });
  });

  it("rejects reserved overrides, bad key syntax, and logLevel before anything is sent", () => {
    const { transport, sent } = scripted((req) => ok(req, {}));
    const client = new McpClient({ transport, server: { key: "s" } });
    expect(() => client.request("tools/list", {}, { meta: { [META_PROTOCOL_VERSION]: "x" } })).toThrow(/WIRE-META-4/);
    expect(() => client.request("tools/list", {}, { meta: { "bad key": 1 } })).toThrow(/WIRE-META-5/);
    expect(() => client.request("tools/list", {}, { meta: { [META_LOG_LEVEL]: "debug" } })).toThrow(/WIRE-LOG-1/);
    expect(() => validateCallerMeta({ "com.example/trace-id": "a" })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it("McpClient.notify delegates to transport.notify with _meta and caller validation", async () => {
    const { transport, notificationsSent } = scripted((req) => ok(req, {}));
    const client = new McpClient({ transport, server: { key: "s", label: "srv" } });
    await expect(client.notify("notifications/initialized", { ready: true }, { meta: { [META_LOG_LEVEL]: "warn" } })).rejects.toThrow(/WIRE-LOG-1/);
    expect(notificationsSent).toHaveLength(0);

    await client.notify("notifications/initialized", { ready: true }, { meta: { trace: "abc" }, headersHint: { name: "h" } });
    expect(notificationsSent).toHaveLength(1);
    const sent = notificationsSent[0]!;
    expect(sent.msg.jsonrpc).toBe("2.0");
    expect(sent.msg.method).toBe("notifications/initialized");
    expect(sent.msg.params).toMatchObject({
      ready: true,
      _meta: {
        [META_PROTOCOL_VERSION]: "2026-07-28",
        [META_CLIENT_INFO]: LIBRARY_CLIENT_INFO,
        trace: "abc",
      },
    });
    expect(sent.ctx.headersHint).toEqual({ name: "h" });
    expect(sent.ctx.serverLabel).toBe("srv");
  });
});

describe("error-code mapping (WIRE-ERR-3/4, VER-7, EDGE-32/34)", () => {
  it("classifies by code only", () => {
    const table: [number, string, string | undefined][] = [
      [-32700, "parse-error", undefined],
      [-32600, "invalid-request", undefined],
      [-32601, "method-not-found", undefined],
      [-32602, "invalid-params", undefined],
      [-32603, "internal-error", undefined],
      [-32020, "header-mismatch", "header-mismatch"],
      [-32021, "missing-client-capability", "missing-client-capability"],
      [-32022, "unsupported-version", "unsupported-version"],
      [-32002, "resource-not-found", "resource-not-found"],
      [-32023, "unknown-reserved", "unknown-reserved"],
      [-32099, "unknown-reserved", "unknown-reserved"],
      [-32042, "unknown-reserved", "unknown-reserved"],
      [-32010, "server-error", undefined],
      [42, "application", undefined],
    ];
    for (const [code, category, refined] of table) {
      const c = classifyJsonRpcError(code);
      expect(c.category, String(code)).toBe(category);
      expect(c.refined, String(code)).toBe(refined);
    }
  });

  it("reads -32021 requiredCapabilities and -32022 supported/requested; ignores malformed data", () => {
    expect(classifyJsonRpcError(-32021, { requiredCapabilities: { elicitation: {} } }).requiredCapabilities).toEqual({ elicitation: {} });
    expect(classifyJsonRpcError(-32022, { supported: ["a"], requested: "b" }).unsupported).toEqual({ supported: ["a"], requested: "b" });
    expect(classifyJsonRpcError(-32022, { supported: [1] }).unsupported).toBeUndefined();
    expect(classifyJsonRpcError(-32601, { extra: true }).category).toBe("method-not-found");
    const o: Outcome<unknown> = { kind: "jsonrpc-error", code: -32021, message: "m", data: { requiredCapabilities: { x: {} } }, meta: META };
    expect(missingClientCapabilities(o)).toEqual({ x: {} });
  });
});

describe("version negotiation (VER-2/3/4)", () => {
  it("selectProtocolVersion uses our preference order", () => {
    expect(selectProtocolVersion(["b", "a"], ["a", "b"])).toBe("b");
    expect(selectProtocolVersion(["c"], ["a", "b"])).toBeUndefined();
  });

  it("no mutual version: one request, unsupported-version diagnostic", async () => {
    const { transport, sent } = scripted((req) => err(req, -32022, "Unsupported", { requested: "2026-07-28", supported: ["2025-11-25"] }));
    const client = new McpClient({ transport, server: { key: "s", label: "my-server" } });
    const out = await client.request("tools/list");
    expect(sent).toHaveLength(1);
    expect(out.kind).toBe("unsupported-version");
    if (out.kind === "unsupported-version") {
      expect(out.detail).toMatchObject({
        binding: "stdio",
        endpointOrCommand: "my-server",
        requested: "2026-07-28",
        supported: ["2025-11-25"],
        observed: "modern-error",
      });
    }
  });

  it("retries at most once (VER-4)", async () => {
    const { transport, sent } = scripted((req) => err(req, -32022, "Unsupported", { requested: "2026-07-28", supported: ["2026-07-28"] }));
    const client = new McpClient({ transport, server: { key: "s" } });
    const out = await client.request("tools/list");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    expect(out).toMatchObject({ kind: "unsupported-version", meta: { attempts: 2 } });
  });

  it("mapLifecycleOutcome passes non--32022 outcomes (including pure mrtr-interim) through and maps -32022", () => {
    const plain: Outcome<unknown> = { kind: "jsonrpc-error", code: -32601, message: "nf", meta: META };
    expect(mapLifecycleOutcome(plain, CTX)).toBe(plain);
    const interim: Outcome<unknown> = {
      kind: "mrtr-interim",
      requestState: "rs-1",
      inputRequests: { q: { method: "elicitation/create", params: {} } },
      meta: META,
    };
    expect(mapLifecycleOutcome(interim, CTX)).toBe(interim);
    const badVer: Outcome<unknown> = { kind: "jsonrpc-error", code: -32022, message: "u", meta: META };
    expect(mapLifecycleOutcome(badVer, CTX).kind).toBe("unsupported-version");
  });
});

describe("discover, era cache, diagnostics (VER-5/6, VER-CACHE-1, VER-DIAG-1)", () => {
  const discover = {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: {},
    ttlMs: 0,
    cacheScope: "private",
  };

  it("classifies discover outcomes", () => {
    expect(classifyDiscoverOutcome({ kind: "ok", value: discover, meta: META }, CTX)).toMatchObject({ era: "modern", version: "2026-07-28" });
    expect(
      classifyDiscoverOutcome({ kind: "ok", value: { ...discover, supportedVersions: ["2030-01-01"] }, meta: META }, CTX),
    ).toMatchObject({ era: "modern-no-mutual", diagnostic: { observed: "modern-error", supported: ["2030-01-01"] } });
    expect(classifyDiscoverOutcome({ kind: "jsonrpc-error", code: -32601, message: "Method not found", meta: META }, CTX)).toMatchObject({
      era: "legacy-or-unresponsive",
      diagnostic: { observed: "other-error", evidence: "-32601 Method not found", endpointOrCommand: "my-server --stdio" },
    });
    expect(
      classifyDiscoverOutcome({ kind: "transport-failure", failure: { kind: "timeout", message: "t" }, safeToRetry: true, meta: META }, CTX),
    ).toMatchObject({ era: "legacy-or-unresponsive", diagnostic: { observed: "timeout" } });
    expect(
      classifyDiscoverOutcome(
        { kind: "transport-failure", failure: { kind: "http-status", status: 404, message: "nf" }, safeToRetry: false, meta: META },
        CTX,
      ),
    ).toMatchObject({ diagnostic: { observed: "http-status" } });
    expect(classifyDiscoverOutcome({ kind: "cancelled", wasSent: false, phase: "queue", meta: META }, CTX).era).toBe("unknown");
  });

  it("does not branch on serverInfo (VER-6)", () => {
    const a = classifyDiscoverOutcome({ kind: "ok", value: discover, meta: META }, CTX);
    const b = classifyDiscoverOutcome(
      { kind: "ok", value: { ...discover, _meta: { "io.modelcontextprotocol/serverInfo": { name: "legacy", version: "0" } } }, meta: META },
      CTX,
    );
    expect(b.era).toBe(a.era);
  });

  it("diagnostic evidence is clipped to 2 KiB and advice never suggests initialize fallback", () => {
    const d = buildUnsupportedVersionDiagnostic(CTX, "other-error", "x".repeat(10_000));
    expect(d.evidence.length).toBe(DIAGNOSTIC_EVIDENCE_MAX);
    expect(d.advice).toMatch(/never falls back to initialize/);
  });

  it("probe sends server/discover once per client and caches only in memory", async () => {
    const { transport, sent } = scripted((req) => ok(req, discover));
    const client = new McpClient({ transport, server: { key: "s" } });
    const [a, b] = await Promise.all([client.probe(), client.probe()]);
    expect(a).toBe(b);
    expect(await client.probe()).toBe(a);
    expect(client.era()).toBe(a);
    expect(sent.map((r) => r.method)).toEqual(["server/discover"]);
    expect(sent.some((r) => r.method === "initialize")).toBe(false);

    const other = new McpClient({ transport, server: { key: "s" } });
    expect(other.era()).toBeUndefined();
    await other.probe();
    expect(sent).toHaveLength(2);
  });

  it("uncacheable verdicts are not stored", async () => {
    const cache = new EraCache();
    const st = await cache.resolve("k", async () => ({ era: "unknown", outcome: { kind: "cancelled", wasSent: false, phase: "queue", meta: META } }));
    expect(st.era).toBe("unknown");
    expect(cache.get("k")).toBeUndefined();
  });

  it("legacy peer: probe yields a populated diagnostic", async () => {
    const { transport } = scripted((req) => err(req, -32601, "Method not found: server/discover"));
    const client = new McpClient({ transport, server: { key: "cmd", label: "node old-server.js" } });
    const st = await client.probe();
    expect(st).toMatchObject({
      era: "legacy-or-unresponsive",
      diagnostic: {
        binding: "stdio",
        endpointOrCommand: "node old-server.js",
        requested: "2026-07-28",
        observed: "other-error",
      },
    });
  });
});

describe("inbound notification policy (WIRE-LOG-1, WIRE-CANCEL-4)", () => {
  const req = (method: string, id = 5): JsonRpcRequest => ({ jsonrpc: "2.0", id, method });
  it("filters by method and listen id", () => {
    expect(defaultNotificationFilter({ jsonrpc: "2.0", method: "notifications/progress" }, req("tools/call"))).toBe("progress");
    expect(defaultNotificationFilter({ jsonrpc: "2.0", method: "notifications/message" }, req("tools/call"))).toBe("drop-log");
    const cancelled = { jsonrpc: "2.0" as const, method: "notifications/cancelled", params: { requestId: 5 } };
    expect(defaultNotificationFilter(cancelled, req("tools/call"))).toBe("drop-cancelled");
    expect(defaultNotificationFilter(cancelled, req("subscriptions/listen"))).toBe("deliver");
    expect(defaultNotificationFilter(cancelled, req("subscriptions/listen", 6))).toBe("drop-cancelled");
    expect(defaultNotificationFilter({ jsonrpc: "2.0", method: "notifications/x" }, req("tools/call"))).toBe("deliver");
  });
});
