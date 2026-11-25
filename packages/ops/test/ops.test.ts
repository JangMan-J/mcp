import { describe, expect, expectTypeOf, it } from "vitest";
import type { JsonRpcRequest, Outcome } from "@mcp/core";
import { createOps, latestWins, mapOutcome, measure, MAX_COMPLETION_VALUES, type ToolCallResult } from "../src/index.js";
import { err, installNetworkSpy, makeClient, ok, paramsOf, settle } from "./helpers.js";

installNetworkSpy();

const TOOLS = {
  tools: [
    { name: "echo", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
    { name: "bad name!", inputSchema: { type: "object" } },
    { name: "echo", inputSchema: { type: "object" } },
    {
      name: "danger",
      inputSchema: { type: "object" },
      annotations: { idempotentHint: true, readOnlyHint: true, destructiveHint: false },
    },
  ],
};

function route(handlers: Record<string, (req: JsonRpcRequest) => ReturnType<ReturnType<typeof ok>> | undefined>) {
  return (req: JsonRpcRequest) => handlers[req.method]?.(req);
}

describe("capability gate (OPS-GATE-1, OPS-COMP-1)", () => {
  it("known-absent capabilities never reach the wire; declared ones do", async () => {
    const { client, transport } = makeClient(ok({ tools: [], prompts: [], resources: [], contents: [], completion: { values: [] } }));
    const ops = createOps(client, { capabilities: { tools: {}, completions: false } });
    expect((await ops.prompts.list()).kind).toBe("capability-absent");
    expect((await ops.prompts.get("p")).kind).toBe("capability-absent");
    expect((await ops.resources.read("file:///a")).kind).toBe("capability-absent");
    expect((await ops.resources.listTemplates()).kind).toBe("capability-absent");
    const comp = await ops.completion.complete({ ref: { type: "ref/prompt", name: "p" }, argument: { name: "a", value: "" } });
    expect(comp).toMatchObject({ kind: "capability-absent", detail: { capability: "completions", wire: false } });
    expect(transport.sent).toHaveLength(0);
    expect((await ops.tools.list()).kind).toBe("ok");
    expect(transport.sent.map((s) => s.method)).toEqual(["tools/list"]);
    await client.close();
  });

  it("a capability getter is read per call", async () => {
    let caps: Record<string, unknown> | undefined;
    const { client, transport } = makeClient(ok({ prompts: [] }));
    const ops = createOps(client, { capabilities: () => caps });
    expect((await ops.prompts.list()).kind).toBe("ok");
    caps = {};
    expect((await ops.prompts.list()).kind).toBe("capability-absent");
    expect(transport.sent).toHaveLength(1);
    await client.close();
  });

  it("unknown discover data: -32601 maps to capability-absent for every family", async () => {
    const { client } = makeClient(err(-32601, "Method not found"));
    const ops = createOps(client);
    for (const o of await Promise.all([
      ops.tools.list(),
      ops.tools.call("x"),
      ops.prompts.list(),
      ops.prompts.get("p"),
      ops.resources.list(),
      ops.resources.read("file:///a"),
      ops.completion.complete({ ref: { type: "ref/resource", uri: "file:///{x}" }, argument: { name: "x", value: "" } }),
    ])) {
      expect(o).toMatchObject({ kind: "capability-absent", detail: { reason: "method-not-found", code: -32601, wire: true } });
    }
    await client.close();
  });
});

describe("tools", () => {
  it("keeps received order and non-conforming or duplicate names with warnings (OPS-TOOLS-2, OPS-TOOLS-4)", async () => {
    const { client } = makeClient(ok(TOOLS));
    const ops = createOps(client);
    const o = await ops.tools.list();
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.tools.map((t) => t.name)).toEqual(["echo", "bad name!", "echo", "danger"]);
    expect(o.value.tools[0]!.nameWarnings).toEqual([]);
    expect(o.value.tools[1]!.nameWarnings).toContain("name-not-1-128-of-[A-Za-z0-9_.-]");
    expect(o.value.tools[2]!.nameWarnings).toContain("duplicate-name");
    expect(o.value.tools[3]!.tool).toBe(TOOLS.tools[3]);
    await client.close();
  });

  it("annotations are untrusted by default and never make tools/call idempotent (OPS-TOOLS-6)", async () => {
    const seen: JsonRpcRequest[] = [];
    const { client } = makeClient(
      route({
        "tools/list": ok(TOOLS),
        "tools/call": (req) => {
          seen.push(req);
          return { kind: "failure", failure: { kind: "stream-broken", message: "x" }, delivery: "maybe-delivered" };
        },
      }),
    );
    const ops = createOps(client);
    const l = await ops.tools.list();
    if (l.kind !== "ok") throw new Error(l.kind);
    expect(l.value.tools[3]!.annotations).toEqual({ value: TOOLS.tools[3]!.annotations, trust: "untrusted" });
    const c = await ops.tools.call("danger", {});
    // Not idempotent: an ambiguous write is reported as uncertain, never retried.
    expect(c.kind).toBe("uncertain-write");
    expect(seen).toHaveLength(1);

    const trusted = createOps(makeClient(ok(TOOLS)).client, { serverTrusted: true });
    const t = await trusted.tools.list();
    if (t.kind !== "ok") throw new Error(t.kind);
    expect(t.value.tools[3]!.annotations?.trust).toBe("trusted");
    await client.close();
  });

  it("sends name and arguments; omits arguments when not given (OPS-TOOLS-7)", async () => {
    const { client, transport } = makeClient(ok({ content: [] }));
    const ops = createOps(client);
    await ops.tools.call("a", { x: 1 });
    await ops.tools.call("b");
    expect(paramsOf(transport.sent[0])).toEqual({ name: "a", arguments: { x: 1 } });
    expect(paramsOf(transport.sent[1])).toEqual({ name: "b" });
    await client.close();
  });

  it("returns the raw complete result untruncated and measures it (OPS-TOOLS-15)", async () => {
    const big = "x".repeat(2_000_000);
    const result = { content: [{ type: "text", text: big }, { type: "text", text: "é" }], structuredContent: { big } };
    const { client } = makeClient(ok(result));
    const o = await createOps(client).tools.call("t", {});
    if (o.kind !== "ok") throw new Error(o.kind);
    expect((o.value.raw["content"] as { text: string }[])[0]!.text).toHaveLength(2_000_000);
    expect(o.value.content[0]!.raw).toEqual(result.content[0]);
    const m = measure(o.value.raw);
    expect(m.blocks.map((b) => b.type)).toEqual(["text", "text"]);
    expect(m.blocks[1]!.bytes).toBe(new TextEncoder().encode(JSON.stringify({ type: "text", text: "é" })).length);
    expect(m.structuredContentBytes).toBeGreaterThan(2_000_000);
    expect(m.totalBytes).toBe(m.blocks[0]!.bytes + m.blocks[1]!.bytes + m.structuredContentBytes);
    await client.close();
  });

  it("applies the caller timeoutMs to tools/call (OPS-TOOLS-16)", async () => {
    const { client } = makeClient(); // never answers
    const o = await createOps(client).tools.call("slow", {}, { timeoutMs: 20, idempotent: true });
    expect(o).toMatchObject({ kind: "transport-failure", failure: { kind: "timeout" } });
    await client.close();
  });

  it("beforeCall veto prevents the send; afterCall sees the outcome (OPS-TOOLS-17)", async () => {
    const after: string[] = [];
    const { client, transport } = makeClient(ok({ content: [] }));
    const ops = createOps(client, {
      hooks: {
        beforeCall: (ctx) => (ctx.name === "rm" ? { veto: "user said no" } : ctx.name === "no" ? false : undefined),
        afterCall: (ctx, o) => {
          after.push(`${ctx.name}:${o.kind}`);
        },
      },
    });
    expect(await ops.tools.call("rm", {})).toMatchObject({ kind: "local-error", detail: { reason: "vetoed", veto: "user said no" } });
    expect((await ops.tools.call("no", {})).kind).toBe("local-error");
    expect(transport.sent).toHaveLength(0);
    expect((await ops.tools.call("ls", {})).kind).toBe("ok");
    expect(transport.sent).toHaveLength(1);
    expect(after).toEqual(["ls:ok"]);
    await client.close();
  });

  it("validates input before send; validateInput:false skips it (OPS-TOOLS-12)", async () => {
    const { client, transport } = makeClient(route({ "tools/list": ok(TOOLS), "tools/call": ok({ content: [] }) }));
    const ops = createOps(client);
    await ops.tools.list();
    const bad = await ops.tools.call("echo", { msg: 1 });
    expect(bad).toMatchObject({ kind: "invalid-arguments", meta: { binding: "local" } });
    // A duplicate name later in the page does not replace the first tool's schema.
    expect(transport.sent.map((s) => s.method)).toEqual(["tools/list"]);
    expect((await ops.tools.call("echo", { msg: 1 }, { validateInput: false })).kind).toBe("ok");
    expect((await ops.tools.call("echo", { msg: "hi" })).kind).toBe("ok");
    expect(transport.sent).toHaveLength(3);
    await client.close();
  });

  it("output validation: valid, skipped, unsupported-dialect", async () => {
    const list = {
      tools: [
        { name: "a", inputSchema: { type: "object" }, outputSchema: { type: "object", properties: { n: { type: "integer" } } } },
        { name: "b", inputSchema: { type: "object" }, outputSchema: { $schema: "http://json-schema.org/draft-04/schema#" } },
      ],
    };
    let reply: Record<string, unknown> = {};
    const { client } = makeClient(route({ "tools/list": ok(list), "tools/call": (req) => ok(reply)(req) }));
    const ops = createOps(client);
    const l = await ops.tools.list();
    if (l.kind !== "ok") throw new Error(l.kind);
    expect(l.value.tools[1]!.outputValidation).toBe("unsupported-dialect");
    reply = { content: [], structuredContent: { n: 1 } };
    expect(await ops.tools.call("a", {})).toMatchObject({ kind: "ok", value: { validation: { status: "valid" } } });
    reply = { content: [] };
    expect(await ops.tools.call("a", {})).toMatchObject({ kind: "ok", value: { validation: { status: "skipped" } } });
    reply = { content: [], structuredContent: 5 };
    expect(await ops.tools.call("b", {})).toMatchObject({ kind: "ok", value: { validation: { status: "unsupported-dialect" } } });
    await client.close();
  });

  it("structuredContent is typed unknown and may be any JSON value (OPS-SCHEMA-7, OPS-TOOLS-10)", async () => {
    expectTypeOf<ToolCallResult["structuredContent"]>().toEqualTypeOf<unknown>();
    for (const v of [[1], "s", 0, false, null, { a: 1 }]) {
      const { client } = makeClient(ok({ content: [], structuredContent: v }));
      const o = await createOps(client).tools.call("t");
      expect(o).toMatchObject({ kind: "ok", value: { structuredContent: v } });
      await client.close();
    }
  });

  it("tools/list malformed entries are excluded with a warning", async () => {
    const { client } = makeClient(ok({ tools: [{ inputSchema: {} }, "x", { name: "ok", inputSchema: true }, { name: "n", inputSchema: {} }] }));
    const o = await createOps(client).tools.list();
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.tools.map((t) => t.name)).toEqual(["n"]);
    expect(o.value.excluded.map((e) => e.reason)).toEqual(["malformed-tool", "malformed-tool", "invalid-inputSchema"]);
    expect(o.value.warnings).toHaveLength(3);
    await client.close();
  });
});

describe("prompts", () => {
  it("get keeps all content block kinds and rejects invalid audio (OPS-PROMPT-2..4)", async () => {
    const messages = [
      { role: "user", content: { type: "text", text: "a" } },
      { role: "assistant", content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
      { role: "user", content: { type: "resource_link", uri: "file:///x", name: "x" } },
      { role: "user", content: { type: "resource", resource: { uri: "file:///b", blob: "AAAA" } } },
    ];
    const { client } = makeClient(ok({ description: "d", messages }));
    const o = await createOps(client).prompts.get("p");
    expect(o).toMatchObject({ kind: "ok", value: { description: "d" } });
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.messages.map((m) => [m.role, m.content.type, m.content.issues.length])).toEqual([
      ["user", "text", 0],
      ["assistant", "image", 0],
      ["user", "resource_link", 0],
      ["user", "resource", 0],
    ]);
    await client.close();

    const bad = makeClient(ok({ messages: [{ role: "user", content: { type: "audio", data: "AAAA", mimeType: "" } }] }));
    expect(await createOps(bad.client).prompts.get("p")).toMatchObject({
      kind: "protocol-violation",
      detail: { reason: "invalid-media", issues: ["invalid-mimeType"] },
    });
    await bad.client.close();
  });
});

describe("resources", () => {
  it("never fetches resource URIs itself; only resources/read goes out (OPS-RES-5)", async () => {
    const { client, transport } = makeClient(ok({ contents: [{ uri: "https://example.com/x", text: "t" }] }));
    const o = await createOps(client).resources.read("https://example.com/x");
    expect(o).toMatchObject({ kind: "ok", value: { contents: [{ uri: "https://example.com/x", text: "t" }] } });
    expect(transport.sent.map((s) => [s.method, paramsOf(s)])).toEqual([["resources/read", { uri: "https://example.com/x" }]]);
    await client.close();
  });

  it("flags invalid URIs per item and keeps the list (OPS-RES-6)", async () => {
    const resources = [
      { uri: "file:///ok", name: "a" },
      { uri: "custom+scheme://host/p?q=1#f", name: "b" },
      { uri: "no scheme", name: "c" },
      { uri: "1bad:x", name: "d" },
      { name: "e" },
    ];
    const { client } = makeClient(ok({ resources }));
    const o = await createOps(client).resources.list();
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.items.map((i) => i.issues)).toEqual([[], [], ["invalid-uri"], ["invalid-uri"], ["missing-uri"]]);
    await client.close();
  });

  it("passes annotations through after the range check (OPS-RES-7)", async () => {
    const resources = [
      { uri: "file:///a", annotations: { priority: 0, audience: ["user"], lastModified: "2025-01-01T00:00:00Z" } },
      { uri: "file:///b", annotations: { priority: 1.0001 } },
      { uri: "file:///c", annotations: { priority: -0.1 } },
      { uri: "file:///d", annotations: { audience: ["robot"] } },
      { uri: "file:///e", annotations: "x" },
    ];
    const { client } = makeClient(ok({ resources }));
    const o = await createOps(client).resources.list();
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.items.map((i) => i.issues)).toEqual([
      [],
      ["annotation-priority-out-of-range"],
      ["annotation-priority-out-of-range"],
      ["annotation-audience-invalid"],
      ["annotations-not-object"],
    ]);
    expect(o.value.items[0]!.raw).toBe(resources[0]);
    await client.close();
  });

  it("read: contents must be an array; entry needs exactly one of text or blob", async () => {
    let reply: Record<string, unknown> = {};
    const { client } = makeClient((req) => ok(reply)(req));
    const ops = createOps(client);
    reply = { contents: "x" };
    expect((await ops.resources.read("file:///a")).kind).toBe("protocol-violation");
    reply = { contents: [{ uri: "file:///a" }] };
    expect((await ops.resources.read("file:///a")).kind).toBe("protocol-violation");
    reply = { contents: [{ uri: "file:///a", blob: "AAAA", mimeType: "not a mime" }] };
    expect(await ops.resources.read("file:///a")).toMatchObject({ kind: "ok", value: { contents: [{ issues: ["invalid-mimeType"] }] } });
    await client.close();
  });

  it("expands a level-4 template locally with no wire call (OPS-RES-2)", async () => {
    const { client, transport } = makeClient();
    const ops = createOps(client);
    expect(ops.resources.expandTemplate("file:///{+path}{?q*}", { path: "a/b c", q: { x: "1", y: "2" } })).toBe(
      "file:///a/b%20c?x=1&y=2",
    );
    expect(transport.sent).toHaveLength(0);
    await client.close();
  });

  it("not-found mapping: -32602 and -32002 refine to resource-not-found; others do not", async () => {
    for (const [code, refined] of [
      [-32602, "resource-not-found"],
      [-32002, "resource-not-found"],
      [-32603, undefined],
    ] as const) {
      const { client } = makeClient(err(code, "x", { uri: "file:///x" }));
      const o = await createOps(client).resources.read("file:///x");
      expect(o.kind).toBe("jsonrpc-error");
      if (o.kind === "jsonrpc-error") {
        expect(o.code).toBe(code);
        expect(o.refined).toBe(refined);
        expect(o.data).toEqual({ uri: "file:///x" });
      }
      await client.close();
    }
  });
});

describe("completion", () => {
  it("sends ref, argument and context; keeps <=100 values untouched (OPS-COMP-2)", async () => {
    const { client, transport } = makeClient(ok({ completion: { values: ["a", "b"], total: 2, hasMore: false } }));
    const o = await createOps(client).completion.complete({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "lang", value: "py" },
      context: { arguments: { x: "1" } },
    });
    expect(o).toMatchObject({ kind: "ok", value: { values: ["a", "b"], total: 2, hasMore: false, truncated: false, originalCount: 2 } });
    expect(paramsOf(transport.sent[0])).toEqual({
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "lang", value: "py" },
      context: { arguments: { x: "1" } },
    });
    expect(MAX_COMPLETION_VALUES).toBe(100);
    await client.close();
  });

  it("latestWins aborts the previous in-flight completion for the same key, without timers (OPS-COMP-3)", async () => {
    const { client, transport } = makeClient();
    const ops = createOps(client);
    const p = { ref: { type: "ref/prompt", name: "p" }, argument: { name: "a", value: "x" } } as const;
    const first = ops.completion.latestWins("k", p);
    await settle();
    const other = ops.completion.latestWins("other", p);
    await settle();
    const second = ops.completion.latestWins("k", { ...p, argument: { name: "a", value: "xy" } });
    await settle();
    expect((await first).kind).toBe("cancelled");
    expect(transport.sent).toHaveLength(3);
    expect(transport.pending).toHaveLength(2);
    transport.reply({ completion: { values: ["o"] } });
    transport.reply({ completion: { values: ["xyz"] } });
    expect(await other).toMatchObject({ kind: "ok", value: { values: ["o"] } });
    expect(await second).toMatchObject({ kind: "ok", value: { values: ["xyz"] } });
    await client.close();
  });

  it("latestWins helper is synchronous-safe and clears finished keys", async () => {
    const lw = latestWins();
    const signals: AbortSignal[] = [];
    lw.run("k", (s) => signals.push(s));
    lw.run("k", (s) => signals.push(s));
    expect(signals.map((s) => s.aborted)).toEqual([false, false]);
    let release!: () => void;
    const pending = lw.run("k", (s) => {
      signals.push(s);
      return new Promise<void>((r) => (release = r));
    });
    lw.run("k", (s) => signals.push(s));
    expect(signals[2]!.aborted).toBe(true);
    release();
    await pending;
  });

  it("mapOutcome preserves pure mrtr-interim data without attaching resume", () => {
    const interim: Outcome<{ x: number }> = {
      kind: "mrtr-interim",
      inputRequests: { consent: { type: "object" } },
      requestState: "state-1",
      meta: { requestId: 1, method: "tools/call", binding: "stdio", attempts: 1 },
    };
    const mapped = mapOutcome<{ x: number }, number>(interim, (v, meta) => ({ kind: "ok", value: v.x + 1, meta }));
    expect(mapped).toEqual(interim);
    expect("resume" in mapped).toBe(false);
  });
});
