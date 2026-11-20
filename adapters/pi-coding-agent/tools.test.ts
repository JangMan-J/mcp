import { expect, it } from "vitest";
import { installCodingTools, type HostToolDefinition, type ToolClient } from "./tools.ts";

const meta = { requestId: 1, method: "tools/call", binding: "http", attempts: 1 };
const flush = () => new Promise(r => setTimeout(r, 0));

function fakeHost() {
  const tools = new Map<string, HostToolDefinition>();
  const bindings = new Map<string, Function>();
  const permissions: string[] = [];
  const host = {
    registerTool: (d: HostToolDefinition) => (tools.set(d.name, d), { dispose: () => void tools.delete(d.name) }),
    sandbox: { bind: (n: string, fn: Function) => (bindings.set(n, fn), { dispose: () => void bindings.delete(n) }) },
    pipeline: async (call: any, signal: AbortSignal) => {
      permissions.push(call.name);
      return tools.get(call.name)!.execute(call.parentToolCallId, call.arguments, signal);
    },
  };
  return { host, tools, bindings, permissions };
}

const client = (calls: unknown[]): ToolClient => ({
  ready: async () => {},
  list: async () => [{ name: "read", description: "read file" }, { name: "run", description: "run code" }, { name: "find", description: "find stuff" }],
  call: async (tool, args) => (calls.push([tool, args]), { kind: "ok", value: { content: [{ type: "text", text: `${tool}!` }], structuredContent: { n: 1 } }, meta }) as any,
});

it("maps aliases and exposure; end to end through the host pipeline", async () => {
  const f = fakeHost(); const calls: unknown[] = [];
  installCodingTools(f.host, [{ server: "s", client: client(calls), tools: {
    read: { alias: "cat" }, run: { exposure: "codemode" }, find: { exposure: "deferred" } } }]);
  await flush();
  expect([...f.tools.keys()].sort()).toEqual(["mcp__s__cat", "mcp__s__run", "tool_search"]);

  const direct = await f.tools.get("mcp__s__cat")!.execute("1", { p: 1 }, new AbortController().signal);
  expect(direct.content[0]!.text).toBe("read!");
  expect(calls[0]).toEqual(["read", { p: 1 }]);

  const raw: any = await f.bindings.get("mcp__s__run")!({ x: 1 }, { parentToolCallId: "p" });
  expect(f.permissions).toEqual(["mcp__s__run"]);
  expect(raw.kind).toBe("ok");
  expect(raw.value.structuredContent).toEqual({ n: 1 });
});

it("tool_search declares deferred tools and reachesTools names them before execution", async () => {
  const f = fakeHost();
  installCodingTools(f.host, [{ server: "s", client: client([]), exposure: "deferred" }]);
  await flush();
  expect(f.tools.has("mcp__s__find")).toBe(false);
  const search = f.tools.get("tool_search")!;
  const sig = new AbortController().signal;
  expect(await search.reachesTools!({ query: "find" }, sig)).toEqual(["mcp__s__find"]);
  expect(f.tools.get("mcp__s__find")!.exposure).toBe("deferred");
  expect((await search.execute("2", { query: "find" }, sig)).content[0]!.text).toContain("mcp__s__find");
});

it("dispose unregisters", async () => {
  const f = fakeHost();
  installCodingTools(f.host, [{ server: "s", client: client([]) }]).dispose();
  expect(f.tools.size).toBe(0);
});
