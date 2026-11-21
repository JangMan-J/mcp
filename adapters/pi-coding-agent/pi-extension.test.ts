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
  return { api, tools, emit, runCmd };
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
