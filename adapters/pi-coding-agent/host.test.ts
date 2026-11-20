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

  it("aborts an in-flight sign-in on session_shutdown, even with a per-command signal", async () => {
    const host = new FakeHost();
    // A real typed McpServerPort whose sign-in only settles via its signal.
    let signInSignal: AbortSignal | undefined;
    let signInEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signInEntered = resolve; });
    const port: McpServerPort = {
      list: () => summaries,
      status: (id) => summaries.find((s) => s.id === id),
      setEnabled: () => undefined,
      signIn: (id, signal) => {
        void id;
        signInSignal = signal;
        signInEntered();
        return new Promise<void>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      start: vi.fn(async () => undefined),
      shutdown: vi.fn(async () => undefined),
    };
    installHost({ host, servers: port });
    await host.run("session_start");

    const external = new AbortController();
    const { context, messages } = ctx();
    const signingIn = host.commands.get("mcp")!.handler("sign-in docs", { ...context, signal: external.signal });
    const rejection = expect(signingIn).rejects.toThrow(/abort/i);
    await entered;
    expect(signInSignal?.aborted).toBe(false);

    await host.run("session_shutdown");
    await rejection;
    expect(signInSignal?.aborted).toBe(true);
    expect(messages.map((m) => m.text)).not.toContain("docs: sign-in complete");
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdown queued during an in-flight start runs after it, exactly once", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    const events: string[] = [];
    let releaseStart!: () => void;
    (port.start as ReturnType<typeof vi.fn>).mockImplementation((s: AbortSignal) => {
      void s;
      events.push("start");
      return new Promise<void>((resolve) => { releaseStart = resolve; });
    });
    (port.shutdown as ReturnType<typeof vi.fn>).mockImplementation(async () => { events.push("shutdown"); });
    installHost({ host, servers: port });

    const starting = host.run("session_start");
    const shuttingDown = host.run("session_shutdown");
    // Shutdown must not overtake the in-flight start.
    expect(events).toEqual(["start"]);
    releaseStart();
    await Promise.all([starting, shuttingDown]);
    expect(events).toEqual(["start", "shutdown"]);
    await host.run("session_shutdown");
    expect(events).toEqual(["start", "shutdown"]);
  });

  it("dispose during an in-flight start aborts it and shuts down once it settles", async () => {
    const host = new FakeHost();
    const { port } = fakeServers();
    let startSignal: AbortSignal | undefined;
    let releaseStart!: () => void;
    (port.start as ReturnType<typeof vi.fn>).mockImplementation((s: AbortSignal) => {
      startSignal = s;
      return new Promise<void>((resolve) => { releaseStart = resolve; });
    });
    const installed = installHost({ host, servers: port });
    const starting = host.run("session_start");

    installed.dispose();
    expect(startSignal?.aborted).toBe(true);
    expect(port.shutdown).not.toHaveBeenCalled();
    releaseStart();
    await starting;
    await vi.waitFor(() => expect(port.shutdown).toHaveBeenCalledTimes(1));
    installed.dispose();
    expect(port.shutdown).toHaveBeenCalledTimes(1);
  });

  it("parseMcpArgs defaults to list and requires an id for mutating subcommands", () => {
    expect(parseMcpArgs("")).toEqual({ sub: "list" });
    expect(parseMcpArgs("enable docs")).toEqual({ sub: "enable", id: "docs" });
    expect(parseMcpArgs("enable")).toBeUndefined();
    expect(parseMcpArgs("wat")).toBeUndefined();
  });
});
