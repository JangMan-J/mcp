import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JSONRPC_VERSION, type ExchangeEnd, type JsonRpcRequest, type Transport, type TransportDiagnostic } from "@mcp-client/core";
import { createLiveMcpServerRuntime, createPiMcpExtension, type PiExtensionAPI } from "./pi-extension.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
const emptyIter = <T>(): AsyncIterable<T> => ({ async *[Symbol.asyncIterator]() {} });

function mockTransport(handler: (msg: JsonRpcRequest) => ExchangeEnd | Promise<ExchangeEnd>): Transport {
  return {
    binding: "stdio",
    diagnostics: emptyIter<TransportDiagnostic>(),
    start(msg) { return { notifications: emptyIter(), done: Promise.resolve().then(() => handler(msg)) }; },
    async notify() {},
    async close() {},
  };
}

function fakePi() {
  const tools = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, ((e: any, c: any) => unknown)[]>();
  const active = new Set<string>();
  let mcpCmd: { handler(args: string, ctx: any): Promise<void> } | undefined;
  const api: PiExtensionAPI = {
    registerCommand(_n, cmd) { mcpCmd = cmd; },
    registerTool(def) { tools.set(def.name as string, def); },
    on(ev, h) {
      const list = handlers.get(ev) ?? [];
      list.push(h);
      handlers.set(ev, list);
      return () => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); };
    },
    getActiveTools: () => [...active],
    setActiveTools(names) { active.clear(); for (const n of names) if (tools.has(n)) active.add(n); },
    getAllTools: () => Array.from(tools.values()) as unknown as ReturnType<NonNullable<PiExtensionAPI["getAllTools"]>>,
  };
  const emit = async (ev: string, e: unknown = {}, c: unknown = { ui: { notify: () => {} } }) => {
    for (const h of handlers.get(ev) ?? []) await h(e, c);
  };
  const runCmd = async (args: string) => {
    const notes: { msg: string; type?: string }[] = [];
    await mcpCmd!.handler(args, { ui: { notify: (msg: string, type?: string) => notes.push({ msg, ...(type !== undefined ? { type } : {}) }) } });
    return notes;
  };
  return { api, tools, active, emit, runCmd };
}

describe("createPiMcpExtension", () => {
  it("discovers server on session_start, registers tools & /mcp, executes tool and handles uncertain-write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake", description: "Demo" } } }));
    let failWrite = false;
    const ext = createPiMcpExtension({
      configDir: dir,
      createTransport: () => mockTransport((msg) => {
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] } } };
        if (msg.method === "tools/call") {
          if (failWrite) return { kind: "failure", failure: { kind: "stream-broken", message: "dropped" }, delivery: "maybe-delivered" };
          return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { echoed: 1 } } } };
        }
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} } };
      }),
    });
    const pi = fakePi();
    ext(pi.api);
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__srv__echo")).toBe(true));
    expect(pi.tools.has("list_mcp_resources")).toBe(true);
    expect(pi.tools.has("read_mcp_resource")).toBe(true);
    const echoTool = pi.tools.get("mcp__srv__echo") as { execute(id: string, p: unknown, s?: AbortSignal): Promise<any> };
    const ok = await echoTool.execute("1", {});
    expect(ok.content[0].text).toContain("ok");
    expect(ok.structuredContent).toEqual({ content: [{ type: "text", text: "ok" }], structuredContent: { echoed: 1 } });
    failWrite = true;
    const err = await echoTool.execute("2", {});
    expect(err.isError).toBe(true);
    expect(err.content[0].text).toContain("may or may not have run");
    await pi.emit("session_shutdown");
  });

  it("handles /mcp list/disable/enable, before_agent_start mcp_servers, and tool_call reachesTools wait", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake", description: "Demo" } } }));
    const ext = createPiMcpExtension({
      configDir: dir,
      createTransport: () => mockTransport((msg) => {
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } } };
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} } };
      }),
    });
    const pi = fakePi();
    ext(pi.api);
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__srv__ping")).toBe(true));
    expect((await pi.runCmd("list"))[0]?.msg).toContain("srv: connected");
    const ev = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await pi.emit("before_agent_start", ev);
    expect(ev.systemPromptOptions.sections["mcp_servers"]).toContain("srv: Demo");
    await pi.runCmd("disable srv");
    expect(pi.tools.get("mcp__srv__ping")?.exposure).toBe("hidden");
    await pi.runCmd("enable srv");
    await vi.waitFor(() => expect(pi.tools.get("mcp__srv__ping")?.exposure).toBe("direct"));
    pi.tools.set("custom", { name: "custom", reachesTools: () => ["mcp__srv__ping"] });
    await pi.emit("tool_call", { toolName: "custom", input: {} });
    await pi.emit("session_shutdown");
  });

  it("[PICA-5] never passes adapter-internal \"builtin\" exposure to pi.registerTool", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake" } } }));
    const ext = createPiMcpExtension({
      configDir: dir,
      createTransport: () => mockTransport((msg) => {
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {}, resources: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } } };
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} } };
      }),
    });
    const pi = fakePi();
    ext(pi.api);
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__srv__echo")).toBe(true));
    const piSupported = new Set(["direct", "model-only", "codemode", "deferred", "hidden"]);
    for (const def of pi.tools.values()) {
      expect(piSupported.has(def.exposure as string), `tool ${def.name} exposure ${def.exposure}`).toBe(true);
    }
    // Adapter-internal builtins (tool_search, resource tools) stay model-visible as "direct".
    expect(pi.tools.get("tool_search")?.exposure).toBe("direct");
    expect(pi.tools.get("list_mcp_resources")?.exposure).toBe("direct");
    expect(pi.tools.get("read_mcp_resource")?.exposure).toBe("direct");
    await pi.emit("session_shutdown");
  });

  it("[PICA-5] activates deferred tools in Pi once tool_search matches them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake", toolExposure: { lookup: "deferred" } } } }));
    const ext = createPiMcpExtension({
      configDir: dir,
      createTransport: () => mockTransport((msg) => {
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "lookup", description: "Find a thing", inputSchema: { type: "object" } }] } } };
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} } };
      }),
    });
    const pi = fakePi();
    ext(pi.api);
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__srv__echo")).toBe(true));
    expect(pi.active.has("mcp__srv__lookup")).toBe(false);
    const search = pi.tools.get("tool_search") as { execute(id: string, p: unknown, s?: AbortSignal): Promise<unknown> };
    await search.execute("1", { query: "lookup" });
    expect(pi.tools.get("mcp__srv__lookup")?.exposure).toBe("deferred");
    expect(pi.active.has("mcp__srv__lookup")).toBe(true);
    await pi.emit("session_shutdown");
  });

  it("maps installed Pi getMcpServers() {name,config,extensionPath} and follows mcp_servers_change register/update/unregister", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    const created: string[] = [];
    const ext = createPiMcpExtension({
      configDir: dir,
      createTransport: (d) => { created.push(`${d.name}:${d.command}`); return mockTransport((msg) => {
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "ping", inputSchema: { type: "object" } }] } } };
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: {} } };
      }); },
    });
    const pi = fakePi();
    // Structural fake of the installed Pi SDK shape.
    let servers: { name: string; config: Record<string, unknown>; extensionPath: string }[] = [{ name: "dyn", config: { command: "one" }, extensionPath: "/ext/a" }];
    ext({ ...pi.api, getMcpServers: () => servers });
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__dyn__ping")).toBe(true));
    expect(created).toContain("dyn:one");
    servers = [{ name: "dyn", config: { command: "two" }, extensionPath: "/ext/a" }];
    await pi.emit("mcp_servers_change");
    await vi.waitFor(() => expect(created).toContain("dyn:two"));
    servers = [];
    await pi.emit("mcp_servers_change");
    await vi.waitFor(() => expect(pi.tools.get("mcp__dyn__ping")?.exposure).toBe("hidden"));
    await pi.emit("session_shutdown");
  });

  it("integrates OtelTelemetryOptions: propagates traceparent in _meta only when contextSource active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-ext-"));
    dirs.push(dir);
    await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake" } } }));
    const metas: { method: string; meta: Record<string, unknown> | undefined }[] = [];
    const tracer = { startSpan: () => ({ setAttribute() {}, recordException() {}, setStatus() {}, end() {} }) };
    let active = false;
    const contextSource = { activeSpanContext: () => active ? { traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", traceFlags: 1 } : undefined };
    const ext = createPiMcpExtension({
      configDir: dir,
      otel: { tracer, contextSource },
      createTransport: () => mockTransport((msg) => {
        metas.push({ method: msg.method, meta: (msg.params as { _meta?: Record<string, unknown> } | undefined)?._meta });
        if (msg.method === "server/discover") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } } } };
        if (msg.method === "tools/list") return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } } };
        return { kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { content: [{ type: "text", text: "ok" }] } } };
      }),
    });
    const pi = fakePi();
    ext(pi.api);
    await pi.emit("session_start");
    await vi.waitFor(() => expect(pi.tools.has("mcp__srv__echo")).toBe(true));
    expect(metas.every(m => m.meta?.["traceparent"] === undefined)).toBe(true);
    active = true;
    const echo = pi.tools.get("mcp__srv__echo") as { execute(id: string, p: unknown, s?: AbortSignal): Promise<any> };
    await echo.execute("1", { secret: "s3cret" });
    const call = metas.find(m => m.method === "tools/call");
    expect(call?.meta?.["traceparent"]).toBe("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    await pi.emit("session_shutdown");
  });

  it("EDGE-27: createLiveMcpServerRuntime aborts StatefulClient transportClosed on close()", async () => {
    const rt = await createLiveMcpServerRuntime(
      { name: "s", source: "global", trusted: true, transport: "stdio", enabled: true, exposure: "direct", command: "fake" },
      { createTransport: () => mockTransport((msg) => ({ kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result: { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: {} } } })) },
    );
    await rt.ready();
    expect(rt.transportClosed.aborted).toBe(false);
    await rt.close();
    expect(rt.transportClosed.aborted).toBe(true);
    const out = await rt.stateful.request("tools/list", {});
    expect(["transport-failure", "cancelled"]).toContain(out.kind);
  });
});
