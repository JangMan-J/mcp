import { describe, expect, it } from "vitest";
import { ExtensionRegistry, type Extension, type ExtensionCapabilities } from "../src/extension.js";
import { McpClient, NotificationQueue, type ExchangeEnd, type JsonRpcNotification, type Transport } from "../src/index.js";

function ext(id: string, caps: ExtensionCapabilities, onDispose: () => void = () => {}): Extension {
  return {
    id,
    capabilities: () => caps,
    attach: () => ({ dispose: onDispose }),
  };
}

describe("ExtensionRegistry.capabilities", () => {
  it("merges the extensions map by subkey across independent extensions", () => {
    const reg = new ExtensionRegistry();
    const aCaps = { extensions: { "io.a/events": { v: 1 } }, tools: { a: true } };
    const bCaps = { extensions: { "io.b/tasks": {} }, tools: { b: true } };
    reg.register(ext("a", aCaps));
    reg.register(ext("b", bCaps));
    const caps = reg.capabilities();
    expect(caps.extensions).toEqual({ "io.a/events": { v: 1 }, "io.b/tasks": {} });
    // Non-`extensions` namespaces keep top-level last-wins semantics.
    expect(caps.tools).toEqual({ b: true });
    // Plugin-returned objects are not mutated.
    expect(aCaps.extensions).toEqual({ "io.a/events": { v: 1 } });
    expect(bCaps.extensions).toEqual({ "io.b/tasks": {} });
  });

  it("does not hand out the plugin's own extensions object", () => {
    const reg = new ExtensionRegistry();
    const aCaps = { extensions: { "io.a/events": {} } };
    reg.register(ext("a", aCaps));
    const caps = reg.capabilities();
    expect(caps.extensions).toEqual(aCaps.extensions);
    expect(caps.extensions).not.toBe(aCaps.extensions);
  });

  it("keeps extensions from an earlier extension when a later one has none", () => {
    const reg = new ExtensionRegistry();
    reg.register(ext("a", { extensions: { "io.a/events": {} } }));
    reg.register(ext("b", { tools: {} }));
    expect(reg.capabilities()).toEqual({ extensions: { "io.a/events": {} }, tools: {} });
  });

  it("dispose removes only that extension and detaches exactly once", () => {
    const reg = new ExtensionRegistry();
    let aDisposed = 0;
    let bDisposed = 0;
    const a = reg.register(ext("a", { extensions: { "io.a/events": {} } }, () => aDisposed++));
    reg.register(ext("b", { extensions: { "io.b/tasks": {} } }, () => bDisposed++));
    a.dispose();
    a.dispose();
    expect(aDisposed).toBe(1);
    expect(bDisposed).toBe(0);
    expect(reg.capabilities()).toEqual({ extensions: { "io.b/tasks": {} } });
    reg.closeAllReverse();
    expect(aDisposed).toBe(1);
    expect(bDisposed).toBe(1);
    expect(reg.capabilities()).toEqual({});
  });

  it("supports optional capabilities and attach, plus onNotification and onRequest on ExtensionHost", async () => {
    const reg = new ExtensionRegistry();
    const received: JsonRpcNotification[] = [];

    // Capability-only extension (no attach shell needed)
    reg.register({
      id: "cap-only",
      capabilities: () => ({ extensions: { "io.example/cap": { enabled: true } } }),
    });

    // Attach-only extension (no capabilities needed)
    const hookReg = reg.register({
      id: "hook-only",
      attach(host) {
        const d1 = host.onNotification?.("notifications/tasks", (n) => received.push(n));
        const d2 = host.onRequest?.("sampling/createMessage", () => ({ ok: true }));
        return {
          dispose() {
            d1?.dispose();
            d2?.dispose();
          },
        };
      },
    });

    expect(reg.capabilities()).toEqual({ extensions: { "io.example/cap": { enabled: true } } });
    expect(reg.resolveRequestHandler("sampling/createMessage")?.({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage" })).toEqual({ ok: true });

    reg.dispatchNotification({ jsonrpc: "2.0", method: "notifications/tasks", params: { taskId: "t1" } });
    expect(received).toHaveLength(1);

    hookReg.dispose();
    expect(reg.resolveRequestHandler("sampling/createMessage")).toBeUndefined();
    reg.dispatchNotification({ jsonrpc: "2.0", method: "notifications/tasks", params: { taskId: "t2" } });
    expect(received).toHaveLength(1);

    // Live dispatch through McpClient
    const liveEvents: JsonRpcNotification[] = [];
    const q = new NotificationQueue<JsonRpcNotification>();
    let resolveDone!: (end: ExchangeEnd) => void;
    const transport: Transport = {
      binding: "stdio",
      start() {
        return { notifications: q, done: new Promise<ExchangeEnd>((r) => (resolveDone = r)) };
      },
      async notify() {},
      async close() {},
      diagnostics: { async *[Symbol.asyncIterator]() {} },
    };
    const client = new McpClient({
      transport,
      server: { key: "s" },
      extensions: [
        {
          id: "live-tasks",
          attach(host) {
            return host.onNotification?.("notifications/tasks", (n) => liveEvents.push(n)) ?? { dispose() {} };
          },
        },
      ],
    });
    const req = client.request("tools/call", { name: "job" });
    q.push({ jsonrpc: "2.0", method: "notifications/tasks", params: { taskId: "t99" } });
    await new Promise((r) => setImmediate(r));
    expect(liveEvents).toEqual([{ jsonrpc: "2.0", method: "notifications/tasks", params: { taskId: "t99" } }]);
    resolveDone({ kind: "response", message: { jsonrpc: "2.0", id: req.id, result: {} } });
    await req;
  });
});
