import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_MCP,
  installHost,
  parseMcpArgs,
  type Disposable,
  type McpCommandContext,
  type McpCommandDefinition,
  type McpServerPort,
  type McpServerSummary,
  type PiHostPort,
  type PiSessionEvent,
  type PiSessionHandler,
} from "./host.ts";

class FakeHost implements PiHostPort {
  commands = new Map<string, McpCommandDefinition>();
  handlers = new Map<PiSessionEvent, Set<PiSessionHandler>>();
  disabledBuiltins = new Set<string>();
  restored: string[] = [];

  registerCommand(name: "mcp", definition: McpCommandDefinition): Disposable {
    this.commands.set(name, definition);
    return { dispose: () => { this.commands.delete(name); } };
  }
  on(event: PiSessionEvent, handler: PiSessionHandler): Disposable {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return { dispose: () => { set.delete(handler); } };
  }
  disableBuiltin(id: typeof BUILTIN_MCP): Disposable {
    this.disabledBuiltins.add(id);
    return { dispose: () => { this.disabledBuiltins.delete(id); this.restored.push(id); } };
  }
  async run(event: PiSessionEvent): Promise<void> {
    for (const h of this.handlers.get(event) ?? []) await h({ notify: () => undefined });
  }
}

const summaries: McpServerSummary[] = [
  { id: "docs", enabled: true, status: "connected" },
  { id: "files", enabled: false, status: "disconnected" },
];

function fakeServers() {
  const state = summaries.map((s) => ({ ...s }));
  const port: McpServerPort = {
    list: () => state.map((s) => ({ ...s })),
    status: (id) => state.find((s) => s.id === id),
    setEnabled: vi.fn((id: string, enabled: boolean) => {
      const s = state.find((x) => x.id === id);
      if (s) s.enabled = enabled;
    }),
    signIn: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    shutdown: vi.fn(async () => undefined),
  };
  return { port, state };
}

function ctx() {
  const messages: { text: string; kind?: string }[] = [];
  const context: McpCommandContext = { notify: (text, kind) => { messages.push({ text, ...(kind ? { kind } : {}) }); } };
  return { context, messages };
}

describe("installHost", () => {
  it("registers /mcp, replaces builtin:mcp, and list dispatch delegates to the server port", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    const installed = installHost({ host, servers: port });
    expect(host.commands.has("mcp")).toBe(true);
    expect(host.disabledBuiltins.has(BUILTIN_MCP)).toBe(true);

    const { context, messages } = ctx();
    await host.commands.get("mcp")!.handler("", context);
    expect(messages[0]?.text).toContain("docs: connected");
    expect(messages[0]?.text).toContain("files: disabled");
    installed.dispose();
  });

  it("dispatches status/enable/disable/sign-in with no protocol logic of its own", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    installHost({ host, servers: port });
    const cmd = host.commands.get("mcp")!;

    const a = ctx();
    await cmd.handler("status docs", a.context);
    expect(a.messages[0]?.text).toBe("docs: connected");

    const b = ctx();
    await cmd.handler("status nope", b.context);
    expect(b.messages[0]).toEqual({ text: "Unknown MCP server: nope", kind: "error" });

    const c = ctx();
    await cmd.handler("disable docs", c.context);
    expect(port.setEnabled).toHaveBeenCalledWith("docs", false);
    expect(c.messages[0]?.text).toContain("disabled");

    const d = ctx();
    await cmd.handler("sign-in docs", d.context);
    expect(port.signIn).toHaveBeenCalledWith("docs", expect.any(AbortSignal));
    expect(d.messages[0]?.text).toContain("sign-in complete");

    const e = ctx();
    await cmd.handler("bogus", e.context);
    expect(e.messages[0]?.kind).toBe("error");
  });

  it("session start/shutdown drive the server port and abort the session signal", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    let startSignal: AbortSignal | undefined;
    (port.start as ReturnType<typeof vi.fn>).mockImplementation(async (s: AbortSignal) => { startSignal = s; });
    installHost({ host, servers: port });

    await host.run("session_start");
    expect(port.start).toHaveBeenCalledTimes(1);
    expect(startSignal?.aborted).toBe(false);

    await host.run("session_shutdown");
    expect(startSignal?.aborted).toBe(true);
    expect(port.shutdown).toHaveBeenCalledTimes(1);

    // Second shutdown is a no-op.
    await host.run("session_shutdown");
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("disposer unregisters, restores builtin:mcp, aborts the session, and is idempotent", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    let startSignal: AbortSignal | undefined;
    (port.start as ReturnType<typeof vi.fn>).mockImplementation(async (s: AbortSignal) => { startSignal = s; });
    const installed = installHost({ host, servers: port });
    await host.run("session_start");

    installed.dispose();
    expect(host.commands.has("mcp")).toBe(false);
    expect(host.handlers.get("session_start")?.size ?? 0).toBe(0);
    expect(host.disabledBuiltins.has(BUILTIN_MCP)).toBe(false);
    expect(host.restored).toEqual([BUILTIN_MCP]);
    expect(startSignal?.aborted).toBe(true);
    expect(port.shutdown).toHaveBeenCalledTimes(1);

    installed.dispose();
    expect(host.restored).toEqual([BUILTIN_MCP]);
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("parseMcpArgs defaults to list and requires an id for mutating subcommands", () => {
    expect(parseMcpArgs("")).toEqual({ sub: "list" });
    expect(parseMcpArgs("enable docs")).toEqual({ sub: "enable", id: "docs" });
    expect(parseMcpArgs("enable")).toBeUndefined();
    expect(parseMcpArgs("wat")).toBeUndefined();
  });
});
