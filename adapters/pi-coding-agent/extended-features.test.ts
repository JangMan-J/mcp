import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedResult, createExtendedFeatures, inspectServerCard, SKILL_TOOL_SCHEMA, TASK_TOOL_SCHEMA } from "./extended-features.js";
import type { ConsentPort } from "@mcp-client/core";
import type { LegacyServerConfig } from "./config.js";
import type { LiveMcpServerRuntime } from "./pi-extension.js";

const meta = (method: string) => ({ requestId: 1, method, binding: "local", attempts: 1 });
const ok = (method: string, value: unknown) => ({ kind: "ok", value, meta: meta(method) });

/** Fixture shape shared with the live check Card: capabilities + scripted method responses. */
function fakeRuntime(caps: Record<string, unknown>, script: Record<string, unknown[]>) {
  const closed = new AbortController();
  const calls: Array<{ method: string; params: unknown }> = [];
  const request = vi.fn((method: string, params: unknown) => {
    calls.push({ method, params });
    const next = script[method]?.shift();
    return Promise.resolve(next === undefined ? { kind: "jsonrpc-error", code: -32601, message: "nope", meta: meta(method) } : ok(method, next));
  });
  const rt = {
    capabilities: caps,
    transportClosed: closed.signal,
    stateful: { request },
    client: { use: vi.fn(() => ({ dispose: vi.fn() })) },
  } as unknown as LiveMcpServerRuntime;
  return { rt, closed, calls };
}

const descriptor = (name: string, extra: Partial<LegacyServerConfig> = {}) =>
  ({ name, source: "user", trusted: true, transport: "stdio", enabled: true, exposure: "direct", ...extra }) as unknown as LegacyServerConfig;

const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };

function setup(consent?: ConsentPort) {
  const tools = new Map<string, Record<string, unknown>>();
  const wake = vi.fn();
  const features = createExtendedFeatures({
    registerTool: def => tools.set(def.name as string, def),
    wake,
    configDir: mkdtempSync(join(tmpdir(), "ext-features-")),
    ...(consent ? { consent } : {}),
  });
  const exec = (name: string, params: Record<string, unknown>) =>
    (tools.get(name)!.execute as (id: string, p: unknown, s: AbortSignal) => Promise<any>)("1", params, new AbortController().signal);
  return { tools, wake, features, exec };
}

describe("extended features", () => {
  it("registers no tools without capabilities", () => {
    const { tools, features } = setup();
    features.connect(fakeRuntime({}, {}).rt, descriptor("a"), new AbortController().signal);
    expect(tools.size).toBe(0);
  });

  it("registers mcp_tasks with shared schema and tracks working -> completed, waking Pi", async () => {
    const { tools, wake, features, exec } = setup();
    const { rt, calls } = fakeRuntime(TASKS, {
      "tools/call": [{ taskId: "t1", status: "working", pollIntervalMs: 1 }],
      "tasks/get": [{ taskId: "t1", status: "working", pollIntervalMs: 1 }, { taskId: "t1", status: "completed" }],
    });
    features.connect(rt, descriptor("a"), new AbortController().signal);
    expect(tools.get("mcp_tasks")!.parameters).toBe(TASK_TOOL_SCHEMA);
    expect(tools.has("mcp_skills")).toBe(false);
    const res = await exec("mcp_tasks", { action: "call", tool: "slow", arguments: { x: 1 } });
    expect(res.structuredContent).toEqual({ taskId: "t1", status: "working" });
    expect(calls[0]).toEqual({ method: "tools/call", params: { name: "slow", arguments: { x: 1 } } });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith("a", "task t1 completed"));
    expect((await exec("mcp_tasks", { action: "active" })).structuredContent).toEqual({ tasks: [] });
  });

  it("routes input_required through interactive consent via tasks/update", async () => {
    const consent = { request: vi.fn<ConsentPort["request"]>(async () => ({ decision: "accept", content: { ok: true } })) };
    const { features, exec, wake } = setup(consent);
    const { rt, calls } = fakeRuntime(TASKS, {
      "tools/call": [{ taskId: "t2", status: "working", pollIntervalMs: 1 }],
      "tasks/get": [{ taskId: "t2", status: "input_required", pollIntervalMs: 1, inputRequests: { q: { method: "elicitation/create", params: { message: "Proceed?" } } } }, { taskId: "t2", status: "completed" }],
      "tasks/update": [{ taskId: "t2", status: "working", pollIntervalMs: 1 }],
    });
    features.connect(rt, descriptor("a"), new AbortController().signal);
    await exec("mcp_tasks", { action: "call", tool: "slow" });
    await vi.waitFor(() => expect(wake).toHaveBeenCalledWith("a", "task t2 completed"));
    expect(consent.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "form-elicitation", message: "Proceed?" }), expect.anything());
    expect(calls.find(c => c.method === "tasks/update")?.params).toEqual({ taskId: "t2", inputResponses: { q: { action: "accept", content: { ok: true } } } });
  });

  it("passes through non-task tool results and cancels by taskId", async () => {
    const { features, exec } = setup();
    const { rt, calls } = fakeRuntime(TASKS, { "tools/call": [{ content: [] }], "tasks/cancel": [{ taskId: "t3", status: "cancelled" }] });
    features.connect(rt, descriptor("a"), new AbortController().signal);
    expect((await exec("mcp_tasks", { action: "call", tool: "fast" })).structuredContent).toEqual({ content: [] });
    expect((await exec("mcp_tasks", { action: "cancel", taskId: "t3" })).structuredContent).toEqual({ taskId: "t3", status: "cancelled" });
    expect(calls.at(-1)!.method).toBe("tasks/cancel");
  });

  it("registers mcp_skills on capability and cleans up on transportClosed", async () => {
    const { tools, features, exec } = setup();
    const { rt, closed } = fakeRuntime({ extensions: { "io.modelcontextprotocol/skills": {} } }, {});
    features.connect(rt, descriptor("s"), new AbortController().signal);
    expect(tools.get("mcp_skills")!.parameters).toBe(SKILL_TOOL_SCHEMA);
    expect(features.servers.get("s")?.skills).toBeDefined();
    closed.abort();
    expect(features.servers.has("s")).toBe(false);
    expect((await exec("mcp_skills", { action: "list" })).isError).toBe(true);
  });

  it("installs the apps hook only with a renderer", () => {
    const { rt } = fakeRuntime({}, {});
    createExtendedFeatures({ registerTool() {}, wake() {}, configDir: tmpdir(), appRenderer: { render() {} } })
      .connect(rt, descriptor("x"), new AbortController().signal);
    expect(rt.client.use).toHaveBeenCalledTimes(1);
  });

  it("bounds text and drops oversized structured content", () => {
    const r = boundedResult({ big: "x".repeat(40_000) });
    expect(r.content[0]!.text.length).toBeLessThan(17_000);
    expect(r.structuredContent).toBeUndefined();
  });

  it("server card inspection is advisory and skips stdio/aborted", async () => {
    expect(await inspectServerCard(descriptor("a"), new AbortController().signal)).toBeUndefined();
    const ac = new AbortController(); ac.abort();
    expect(await inspectServerCard(descriptor("h", { transport: "http", url: "https://example.invalid/mcp" }), ac.signal)).toBeUndefined();
  });
});
