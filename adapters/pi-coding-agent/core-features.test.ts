import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { NotificationQueue, type JsonRpcNotification, type Outcome, type StreamHandle } from "@mcp-client/core";
import { SUBSCRIPTION_ID, SubscriptionManager, type GrantedFilter } from "@mcp-client/mrtr-cache";
import { createOps, localMeta, type OpsClient } from "@mcp-client/ops";
import { expect, it, vi } from "vitest";
import { createCoreFeatures, type CoreFeaturesHost } from "./core-features.js";
import type { HostToolDefinition } from "./tools.js";

function shell() {
  const tools = new Map<string, HostToolDefinition>();
  let command!: Parameters<CoreFeaturesHost["registerCommand"]>[1];
  const host: CoreFeaturesHost = {
    registerTool: tool => tools.set(tool.name, tool),
    registerCommand: (name, cmd) => { expect(name).toBe("mcp-prompt"); command = cmd; },
    wake: vi.fn(), refreshTools: vi.fn(),
  };
  const features = createCoreFeatures(host);
  const session = new AbortController();
  const run = (kind: "prompts" | "resources", action: string, params: object = {}, signal = session.signal) =>
    tools.get(`mcp_${kind}`)!.execute("test", { action, ...params }, signal);
  return { host, features, tools, run, session, command };
}

function fakeOps(reply: (method: string) => Record<string, unknown>) {
  const request = vi.fn(async (method: string, _params: unknown, _opts: unknown) =>
    ({ kind: "ok", value: reply(method), meta: localMeta(method) }));
  return { request, ops: createOps({ request: request as unknown as OpsClient["request"] }) };
}

it("routes prompt actions and /mcp-prompt through stable Ops and negotiated capabilities", async () => {
  const { features, run, session, command, tools } = shell();
  const { ops, request } = fakeOps(method => ({
    "prompts/list": { prompts: [{ name: "hello" }], nextCursor: "p2" },
    "prompts/get": { messages: [{ role: "user", content: { type: "text", text: "Hello!" } }] },
    "completion/complete": { completion: { values: ["Earth"] } },
  })[method] ?? {});
  const transport = new AbortController();
  const rt = { ops, transportClosed: transport.signal, stateful: {} };
  features.connect({ ...rt, capabilities: { prompts: {}, completions: {} } }, { name: "alpha", aliases: ["a"] }, session.signal);
  features.connect({ ...rt, capabilities: { resources: {} } }, { name: "beta" }, session.signal);
  expect([...tools.keys()]).toEqual(["mcp_prompts", "mcp_resources"]);
  expect(tools.get("mcp_prompts")?.parameters).toMatchObject({ required: ["action"], properties: { action: { enum: ["list", "get", "complete"] } } });
  expect(await run("prompts", "list")).toHaveProperty("structuredContent.servers", [{ server: "alpha", prompts: [{ name: "hello" }], nextCursor: "p2" }]);
  await expect(run("prompts", "get", { server: "beta", name: "hello" })).rejects.toThrow("does not advertise prompts");
  expect(await run("prompts", "complete", { server: "a", name: "hello", argument: "world", value: "", arguments: { lang: "en" } }))
    .toMatchObject({ structuredContent: { server: "alpha", values: ["Earth"] } });
  expect(request).toHaveBeenLastCalledWith("completion/complete", {
    ref: { type: "ref/prompt", name: "hello" }, argument: { name: "world", value: "" }, context: { arguments: { lang: "en" } },
  }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const notify = vi.fn();
  await command.handler('a hello {"world":"Earth"}', { notify });
  expect(request).toHaveBeenLastCalledWith("prompts/get", { name: "hello", arguments: { world: "Earth" } }, expect.anything());
  expect(notify).toHaveBeenCalledWith(expect.stringContaining("Hello!"), "info");
  transport.abort();
  expect(await run("prompts", "list")).toHaveProperty("structuredContent.servers", []);
});

it("browses resource listings and returns bounded text with full structured read output", async () => {
  const { features, run, session } = shell();
  const uri = "file:///memo";
  const text = "🌍".repeat(6_000);
  const { ops, request } = fakeOps(method => ({
    "resources/list": { resources: [{ uri }], nextCursor: "r2" },
    "resources/templates/list": { resourceTemplates: [{ uriTemplate: "file:///{filename}" }] },
    "resources/read": { contents: [{ uri, text }] },
  })[method] ?? {});
  features.connect({ ops, transportClosed: session.signal, stateful: {}, capabilities: { resources: {} } }, { name: "alpha" }, session.signal);
  expect(await run("resources", "directory", { server: "alpha" })).toMatchObject({
    structuredContent: { server: "alpha", resources: [{ uri }], nextResourceCursor: "r2", resourceTemplates: [{ uriTemplate: "file:///{filename}" }] },
  });
  await run("resources", "templates", { server: "alpha", cursor: "t2" });
  expect(request).toHaveBeenLastCalledWith("resources/templates/list", { cursor: "t2" }, expect.anything());
  expect(await run("resources", "list", { server: "alpha", cursor: "r1" }))
    .toMatchObject({ structuredContent: { server: "alpha", resources: [{ uri }], nextCursor: "r2" } });
  expect(request).toHaveBeenLastCalledWith("resources/list", { cursor: "r1" }, expect.anything());
  const read = await run("resources", "read", { uri });
  try {
    expect(read).toMatchObject({ structuredContent: { server: "alpha", uri, contents: [{ uri, text }] } });
    expect(read.content[0]?.type).toBe("text");
    if (read.content[0]?.type === "text") expect(Buffer.byteLength(read.content[0].text)).toBeLessThanOrEqual(20 * 1024);
    expect(read.details.spillPath).toBeDefined();
  } finally {
    if (read.details.spillPath) await rm(dirname(read.details.spillPath), { recursive: true, force: true });
  }
  await expect(run("resources", "subscribe", { uri })).rejects.toThrow("unavailable");
  expect(request.mock.calls.map(([method]) => method)).not.toContain("resources/subscribe");
});

function subscriptions(capabilities: Record<string, unknown>) {
  const streams: Array<ReturnType<typeof stream>> = [];
  function stream(id: number, filter: GrantedFilter) {
    const queue = new NotificationQueue<JsonRpcNotification>();
    const handle: StreamHandle = {
      id, done: new Promise<Outcome<unknown>>(() => {}),
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](), close: vi.fn(() => queue.close()),
    };
    const send = (method: string, params: Record<string, unknown> = {}) => manager.route({
      jsonrpc: "2.0", method, params: { ...params, _meta: { [SUBSCRIPTION_ID]: id } },
    }, id);
    return { handle, filter, send, ack: (notifications = filter) => send("notifications/subscriptions/acknowledged", { notifications }) };
  }
  const manager = new SubscriptionManager({
    binding: "http", serverRef: "alpha", capabilities,
    open(method, params) {
      expect(method).toBe("subscriptions/listen");
      const next = stream(streams.length + 1, params.notifications);
      streams.push(next);
      return next.handle;
    },
  });
  return { manager, streams };
}

it("multiplexes negotiated updates, swaps only acknowledged filters, and closes active and pending streams", async () => {
  const { features, host, run, session } = shell();
  const { ops } = fakeOps(() => ({}));
  const capabilities = { resources: { listChanged: true, subscribe: true }, tools: { listChanged: true }, prompts: {} };
  const { manager, streams } = subscriptions(capabilities);
  const transport = new AbortController();
  const uri = "file:///memo";
  features.connect({ ops, capabilities, stateful: { subscriptions: manager }, transportClosed: transport.signal }, { name: "alpha" }, session.signal);
  try {
    const initial = streams[0]!;
    expect(initial.filter).toEqual({ resourcesListChanged: true, toolsListChanged: true });
    initial.ack();
    const add = run("resources", "subscribe", { uri });
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    const combined = streams[1]!;
    expect(combined.filter).toEqual({ ...initial.filter, resourceSubscriptions: [uri] });
    expect(initial.handle.close).not.toHaveBeenCalled();
    combined.ack();
    expect(await add).toMatchObject({ structuredContent: { uris: [uri] } });
    expect(initial.handle.close).toHaveBeenCalledOnce();
    combined.send("notifications/tools/list_changed");
    combined.send("notifications/resources/list_changed");
    combined.send("notifications/resources/updated", { uri });
    await vi.waitFor(() => expect(host.wake).toHaveBeenCalledWith("alpha", expect.stringContaining(uri)));
    expect(host.wake).toHaveBeenCalledWith("alpha", "Resource list changed");
    expect(host.refreshTools).toHaveBeenCalledOnce();
    const denied = run("resources", "subscribe", { uri: "file:///denied" });
    const deniedResult = expect(denied).rejects.toThrow("did not grant");
    await vi.waitFor(() => expect(streams).toHaveLength(3));
    streams[2]!.ack(combined.filter);
    await deniedResult;
    expect(streams[2]!.handle.close).toHaveBeenCalledOnce();
    expect(combined.handle.close).not.toHaveBeenCalled();
    expect(await run("resources", "subscriptions")).toMatchObject({ structuredContent: { subscriptions: [{ server: "alpha", uris: [uri], state: "active" }] } });
    const remove = run("resources", "unsubscribe", { uri });
    await vi.waitFor(() => expect(streams).toHaveLength(4));
    expect(streams[3]!.filter).toEqual(initial.filter);
    streams[3]!.ack();
    expect(await remove).toMatchObject({ structuredContent: { uris: [] } });
    const pending = run("resources", "subscribe", { uri });
    const closedResult = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(streams).toHaveLength(5));
    transport.abort();
    await closedResult;
    expect(streams[3]!.handle.close).toHaveBeenCalledOnce();
    expect(streams[4]!.handle.close).toHaveBeenCalledOnce();
    expect(await run("resources", "subscriptions")).toHaveProperty("structuredContent.subscriptions", []);
  } finally {
    transport.abort();
  }
});
