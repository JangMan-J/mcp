import { expect, it } from "vitest";
import { toolName } from "./tool-name.ts";
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
  expect((direct.content[0] as { text: string }).text).toBe("read!");
  expect(calls[0]).toEqual(["read", { p: 1 }]);

  const raw: any = await f.bindings.get("mcp__s__run")!({ x: 1 }, { parentToolCallId: "p" });
  expect(f.permissions).toEqual(["mcp__s__run"]);
  expect(raw.kind).toBeUndefined();
  expect(raw.structuredContent).toEqual({ n: 1 });
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
  expect(((await search.execute("2", { query: "find" }, sig)).content[0] as { text: string }).text).toContain("mcp__s__find");
});

it("dispose unregisters", async () => {
  const f = fakeHost();
  installCodingTools(f.host, [{ server: "s", client: client([]) }]).dispose();
  expect(f.tools.size).toBe(0);
});

it("codemode gets raw CallToolResult; failures throw; direct and deferred are bound; late calls blocked", async () => {
  const f = fakeHost(); let next: any;
  const c: ToolClient = { ...client([]), call: async () => next };
  const d = installCodingTools(f.host, [{ server: "s", client: c, tools: { find: { exposure: "deferred" } } }]);
  await flush();
  await f.tools.get("tool_search")!.reachesTools!({ query: "find" }, new AbortController().signal);
  expect([...f.bindings.keys()].sort()).toEqual(["mcp__s__find", "mcp__s__read", "mcp__s__run"]);
  const result = { content: [{ type: "text", text: "bad" }], isError: true };
  next = { kind: "tool-isError", result, meta };
  expect(await f.bindings.get("mcp__s__read")!({}, { parentToolCallId: "p" })).toBe(result);
  next = { kind: "uncertain-write", uncertain: {}, meta };
  await expect(f.bindings.get("mcp__s__read")!({}, { parentToolCallId: "p" })).rejects.toThrow(/uncertain write.*Not retried/);
  const exec = f.tools.get("mcp__s__read")!.execute;
  const bound = f.bindings.get("mcp__s__read")!;
  d.dispose();
  await expect(exec("1", {}, new AbortController().signal)).rejects.toThrow(/disposed/);
  await expect(bound({}, { parentToolCallId: "p" })).rejects.toThrow(/disposed/);
});

it("resolves wildcard toolExposure in precedence order and filters hidden tools from host, sandbox, and tool_search", async () => {
  const f = fakeHost();
  const c: ToolClient = {
    ready: async () => {},
    list: async () => [
      { name: "read_file", description: "read file" },
      { name: "read_secret", description: "read secret" },
      { name: "read_deferred", description: "read deferred" },
      { name: "a.b_ok", description: "escaped dot" },
      { name: "axb_no", description: "should stay hidden" },
      { name: "write_file", description: "write file" },
    ],
    call: async () => ({ kind: "ok", value: {}, meta }) as any,
  };
  installCodingTools(f.host, [{
    server: "fs",
    client: c,
    exposure: "hidden",
    tools: {
      read_secret: { exposure: "hidden" },
    },
    toolExposure: {
      read_deferred: "deferred",
      "read_*": "direct",
      "read_file": "codemode",
      "a.b*": "codemode",
    },
  }]);
  await flush();

  // Exact toolExposure ("read_file" -> codemode) and exact tools ("read_secret" -> hidden) beat "read_*".
  // "a.b*" matches "a.b_ok" but not "axb_no" (dot escaped).
  const abName = toolName("fs", "a.b_ok");
  expect([...f.tools.keys()].sort()).toEqual([abName, "mcp__fs__read_file", "tool_search"]);
  expect(f.tools.get("mcp__fs__read_file")!.exposure).toBe("codemode");
  expect([...f.bindings.keys()].sort()).toEqual([abName, "mcp__fs__read_file"]);

  // First matching wildcard wins in insertion order ("read_*" before anything later, and hidden tools never appear in tool_search).
  const sig = new AbortController().signal;
  const search = f.tools.get("tool_search")!;
  expect(await search.reachesTools!({ query: "read" }, sig)).toEqual(["mcp__fs__read_deferred"]);
  expect(await search.reachesTools!({ query: "write" }, sig)).toEqual([]);
  expect(await search.reachesTools!({ query: "axb" }, sig)).toEqual([]);
});

it("first matching wildcard wins in insertion order", async () => {
  const f = fakeHost();
  const c: ToolClient = {
    ready: async () => {},
    list: async () => [{ name: "safe_read" }],
    call: async () => ({ kind: "ok", value: {}, meta }) as any,
  };
  installCodingTools(f.host, [{
    server: "s",
    client: c,
    toolExposure: {
      "safe_*": "codemode",
      "*_read": "deferred",
    },
  }]);
  await flush();
  expect(f.tools.get("mcp__s__safe_read")?.exposure).toBe("codemode");
});

it("propagates parameters, outputSchema, annotations, and namespace metadata", async () => {
  const f = fakeHost();
  const inputSchema = { type: "object", properties: { q: { type: "string" } } };
  const outputSchema = { type: "object", properties: { ok: { type: "boolean" } } };
  const annotations = { readOnlyHint: true, idempotentHint: true };
  const c: ToolClient = {
    ready: async () => {},
    list: async () => [
      { name: "rich", description: "rich tool", inputSchema, outputSchema, annotations },
      { name: "plain" },
    ],
    call: async () => ({ kind: "ok", value: {}, meta }) as any,
  };
  installCodingTools(f.host, [{
    server: "docs",
    client: c,
    aliases: ["d"],
    description: "Docs server",
    instructions: "Use for docs",
  }]);
  await flush();

  const rich = f.tools.get("mcp__docs__rich")!;
  expect(rich.parameters).toEqual(inputSchema);
  expect(rich.outputSchema).toEqual(outputSchema);
  expect(rich.annotations).toEqual(annotations);
  expect(rich.namespace).toEqual({
    name: "mcp__docs",
    aliases: ["d"],
    description: "Docs server",
    instructions: "Use for docs",
  });

  const plain = f.tools.get("mcp__docs__plain")!;
  expect("parameters" in plain).toBe(false);
  expect("outputSchema" in plain).toBe(false);
  expect("annotations" in plain).toBe(false);
  expect(plain.namespace?.name).toBe("mcp__docs");
});

it("filters tool_search by namespace (server name, mcp__ prefix, or alias)", async () => {
  const f = fakeHost();
  let codeReadyCount = 0;
  const docsClient: ToolClient = {
    ready: async () => {},
    list: async () => [{ name: "search", description: "search docs" }],
    call: async () => ({ kind: "ok", value: {}, meta }) as any,
  };
  const codeClient: ToolClient = {
    ready: async () => { codeReadyCount++; },
    list: async () => [{ name: "search", description: "search code" }],
    call: async () => ({ kind: "ok", value: {}, meta }) as any,
  };
  installCodingTools(f.host, [
    { server: "docs", aliases: ["d"], exposure: "deferred", client: docsClient },
    { server: "code", exposure: "deferred", client: codeClient },
  ]);
  await flush();
  codeReadyCount = 0;

  const sig = new AbortController().signal;
  const search = f.tools.get("tool_search")!;

  expect(await search.reachesTools!({ query: "search", namespace: "docs" }, sig)).toEqual(["mcp__docs__search"]);
  expect(await search.reachesTools!({ query: "search", namespace: "mcp__docs" }, sig)).toEqual(["mcp__docs__search"]);
  expect(await search.reachesTools!({ query: "search", namespace: "d" }, sig)).toEqual(["mcp__docs__search"]);
  expect(codeReadyCount).toBe(0);

  expect(await search.reachesTools!({ query: "search" }, sig)).toEqual(["mcp__docs__search", "mcp__code__search"]);
  expect(codeReadyCount).toBe(1);
});
