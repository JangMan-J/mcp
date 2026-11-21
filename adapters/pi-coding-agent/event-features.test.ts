import { describe, expect, it, vi } from "vitest";
import {
  createMonotonicIdGenerator,
  NotificationQueue,
  type ExchangeEnd,
  type JsonRpcNotification,
  type Transport,
} from "@mcp-client/core";
import {
  createEventsExtension,
  EVENTS_EXTENSION_ID,
  openEventsStream,
} from "@mcp-client/ext-events";
import {
  createEventFeatures,
  Dedup,
  EVENTS_ENTRY_TYPE,
  globToRegExp,
  matchRules,
  restoreEntry,
  type EventFeaturesHost,
  type EventsRuntime,
} from "./event-features.js";
import type { LiveMcpServerRuntime } from "./pi-extension.js";
import type { LegacyServerConfig } from "./config.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

function fakeServer(events: { eventId: string; name: string; data: unknown }[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const closed = new AbortController();
  const caps = { extensions: { [EVENTS_EXTENSION_ID]: {} } };
  const rt = {
    capabilities: caps,
    transportClosed: closed.signal,
    ready: async () => ({ kind: "ok", value: { capabilities: caps } }),
    client: {
      request: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        if (method === "events/list") return { kind: "ok", value: { events: [{ name: "build.done" }, { name: "build.fail" }, { name: "deploy" }] } };
        if (method === "events/poll") {
          const start = params.cursor ? Number(params.cursor) : 0;
          const evs = events.slice(start).filter((e) => e.name === params.name).map((e) => ({ ...e, timestamp: "t" }));
          return { kind: "ok", value: { events: evs, cursor: String(events.length), nextPollMs: 1000 } };
        }
        return { kind: "error" };
      },
    },
  } as unknown as LiveMcpServerRuntime;
  return { rt, calls, closed };
}

function fakeHost(branch: unknown[] = []) {
  const tools = new Map<string, any>();
  const wakes: string[] = [];
  const host: EventFeaturesHost = {
    registerTool: (d) => { tools.set(d.name as string, d); },
    registerCommand: () => {},
    wake: (s, r) => { wakes.push(`${s}:${r}`); },
    refreshTools: () => {},
    getBranch: () => branch,
    appendEntry: (type, data) => { branch.push({ type, data }); },
    configDir: "/tmp",
  };
  return { host, tools, wakes, branch };
}

const desc = (subscribe?: unknown) => ({ name: "srv", subscribe } as unknown as LegacyServerConfig);

describe("event-features helpers", () => {
  it("glob matches names", () => {
    expect(globToRegExp("build.*").test("build.done")).toBe(true);
    expect(globToRegExp("build.*").test("buildXdone")).toBe(false);
    expect(globToRegExp("d?ploy").test("deploy")).toBe(true);
    expect(matchRules(["build.done", "build.fail", "deploy"], ["build.*", { name: "deploy", arguments: { env: "x" } }]))
      .toEqual([{ name: "build.done", arguments: {} }, { name: "build.fail", arguments: {} }, { name: "deploy", arguments: { env: "x" } }]);
    expect(matchRules(["a"], undefined)).toEqual([]);
  });
  it("dedup is bounded and ordered", () => {
    const d = new Dedup(2);
    expect(d.add("a")).toBe(true);
    expect(d.add("a")).toBe(false);
    d.add("b"); d.add("c");
    expect(d.list()).toEqual(["b", "c"]);
    expect(d.has("a")).toBe(false);
  });
  it("restores the latest entry for a server (direct and Pi custom entry forms)", () => {
    const b = [
      { type: EVENTS_ENTRY_TYPE, data: { server: "srv", subs: [] } },
      { type: "custom", customType: EVENTS_ENTRY_TYPE, data: { server: "srv", subs: [{ name: "x", cursor: "1", seen: [] }] } },
      { type: EVENTS_ENTRY_TYPE, data: { server: "o", subs: [] } },
    ];
    expect(restoreEntry(b, "srv")?.subs[0]?.cursor).toBe("1");
  });
  it("matches named record subscribe rules with delivery/holdSettle/maxAgeMs", () => {
    expect(matchRules(["build.done", "build.fail", "deploy"], {
      "build.*": { delivery: "poll", holdSettle: true, maxAgeMs: 5000 },
      deploy: { arguments: { env: "prod" }, delivery: "push" },
      ignored: false,
    })).toEqual([
      { name: "build.done", arguments: {}, delivery: "poll", holdSettle: true, maxAgeMs: 5000 },
      { name: "build.fail", arguments: {}, delivery: "poll", holdSettle: true, maxAgeMs: 5000 },
      { name: "deploy", arguments: { env: "prod" }, delivery: "push" },
    ]);
  });
});

describe("createEventFeatures", () => {
  const evs = [{ eventId: "e1", name: "build.done", data: { n: 1 } }, { eventId: "e2", name: "build.done", data: { n: 2 } }, { eventId: "e3", name: "deploy", data: {} }];

  it("auto-subscribes by glob, catches up, delivers once, persists accepted cursor without data", async () => {
    const { rt, calls } = fakeServer(evs);
    const { host, tools, wakes, branch } = fakeHost();
    const f = createEventFeatures(host);
    expect(f.connect(rt, desc(["build.*"]), new AbortController().signal)).toBeUndefined();
    await tick();
    expect(calls.some((c) => c.method === "events/list")).toBe(true);
    expect(wakes.length).toBeGreaterThan(0);
    const tool = tools.get("mcp_events");
    expect(tool.parameters.required).toEqual(["action"]);
    const subs = await tool.execute("1", { action: "subscriptions", server: "srv" });
    expect(subs.details.subscriptions.map((s: any) => s.name).sort()).toEqual(["build.done", "build.fail"]);
    const r = await tool.execute("2", { action: "poll", server: "srv" });
    expect(r.content[0].type).toBe("text");
    expect(r.details.events.map((e: any) => e.eventId)).toEqual(["e1", "e2"]);
    const again = await tool.execute("3", { action: "poll", server: "srv" });
    expect(again.details.events).toEqual([]);
    const entry = restoreEntry(branch, "srv")!;
    expect(entry.subs.find((s) => s.name === "build.done")).toEqual({ name: "build.done", cursor: "3", seen: ["e1", "e2"] });
    expect(JSON.stringify(branch)).not.toContain("\"n\":");
  });

  it("resumes from persisted cursor and dedups by eventId", async () => {
    const { rt, calls } = fakeServer(evs);
    const { host, tools } = fakeHost([{ type: EVENTS_ENTRY_TYPE, data: { server: "srv", subs: [{ name: "build.done", cursor: "1", seen: ["e2"] }] } }]);
    createEventFeatures(host).connect(rt, desc(["build.done"]), new AbortController().signal);
    await tick();
    expect(calls.find((c) => c.method === "events/poll")?.params.cursor).toBe("1");
    const r = await tools.get("mcp_events").execute("1", { action: "poll", server: "srv" });
    expect(r.details.events).toEqual([]);
  });

  it("manual subscribe/unsubscribe/list/servers and cleanup on transport close", async () => {
    const { rt, closed } = fakeServer(evs);
    const { host, tools } = fakeHost();
    createEventFeatures(host).connect(rt, desc(), new AbortController().signal);
    await tick();
    const t = tools.get("mcp_events");
    expect((await t.execute("1", { action: "servers" })).details.servers).toEqual(["srv"]);
    expect((await t.execute("1", { action: "list", server: "srv" })).content[0].text).toContain("deploy");
    await t.execute("1", { action: "subscribe", server: "srv", name: "deploy" });
    await tick();
    expect((await t.execute("1", { action: "poll", server: "srv" })).details.events.map((e: any) => e.eventId)).toEqual(["e3"]);
    expect((await t.execute("1", { action: "unsubscribe", server: "srv", name: "deploy" })).details.removed).toBe(1);
    closed.abort();
    const r = await t.execute("1", { action: "poll", server: "srv" });
    expect(r.isError).toBe(true);
  });

  it("skips servers without the events capability", async () => {
    const { rt } = fakeServer(evs);
    (rt as any).capabilities = {};
    const { host, tools } = fakeHost();
    createEventFeatures(host).connect(rt, desc(["*"]), new AbortController().signal);
    await tick();
    expect(tools.size).toBe(0);
  });

  it("wires openEventsStream for push delivery and aborts stream on connect signal abort", async () => {
    const { rt } = fakeServer([]);
    const ext = createEventsExtension({ enabled: true });
    const nextId = createMonotonicIdGenerator();
    let streamQueue: NotificationQueue<JsonRpcNotification> | undefined;
    let streamId: string | number | undefined;
    let streamAborted = false;
    const empty = { async *[Symbol.asyncIterator]() {} };
    const transport: Transport = {
      binding: "streamable-http",
      diagnostics: empty,
      async close() {},
      async notify() {},
      start(req, ctx) {
        streamId = req.id;
        const q = new NotificationQueue<JsonRpcNotification>();
        streamQueue = q;
        const done = new Promise<ExchangeEnd>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            streamAborted = true;
            q.close();
            resolve({ kind: "response", message: { jsonrpc: "2.0", id: req.id, result: {} } });
          }, { once: true });
        });
        return { notifications: q, done };
      },
    };
    const ert: EventsRuntime = Object.assign(rt, {
      eventsExtension: ext,
      openEventsStream: openEventsStream(transport, nextId, () => ext.capabilities(true)),
    });
    const { host, tools, wakes, branch } = fakeHost();
    const ac = new AbortController();
    createEventFeatures(host).connect(ert, desc({ "build.done": true }), ac.signal);
    await tick();
    expect(streamQueue).toBeDefined();
    expect(streamId).toBeDefined();
    streamQueue!.push({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { heartbeatMs: 10_000, cursor: "c0", _meta: { "io.modelcontextprotocol/subscriptionId": streamId } },
    });
    streamQueue!.push({
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: {
        eventId: "p1",
        name: "build.done",
        timestamp: new Date().toISOString(),
        data: { ok: true },
        cursor: "c1",
        _meta: { "io.modelcontextprotocol/subscriptionId": streamId },
      },
    });
    await tick();
    expect(wakes).toContain("srv:event build.done");
    const r = await tools.get("mcp_events").execute("1", { action: "poll", server: "srv" });
    expect(r.details.events.map((e: any) => e.eventId)).toEqual(["p1"]);
    expect(restoreEntry(branch, "srv")?.subs.find((s) => s.name === "build.done")).toEqual({
      name: "build.done",
      cursor: "c1",
      seen: ["p1"],
    });
    ac.abort();
    await tick();
    expect(streamAborted).toBe(true);
    expect((await tools.get("mcp_events").execute("2", { action: "poll", server: "srv" })).isError).toBe(true);
  });

  it("delivery:'poll' suppresses push and runs bounded scheduled polling until cleaned up", async () => {
    vi.useFakeTimers();
    try {
      const liveEvents: { eventId: string; name: string; data: unknown }[] = [];
      const { rt, calls, closed } = fakeServer(liveEvents);
      let openStreamCalls = 0;
      const ert: EventsRuntime = Object.assign(rt, {
        openEventsStream: () => {
          openStreamCalls++;
          throw new Error("should not open push stream when delivery is poll");
        },
      });
      const { host, tools, wakes } = fakeHost();
      createEventFeatures(host).connect(
        ert,
        desc({ "build.done": { delivery: "poll", holdSettle: false } }),
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(openStreamCalls).toBe(0);
      const initialPolls = calls.filter((c) => c.method === "events/poll").length;
      expect(initialPolls).toBeGreaterThanOrEqual(1);

      liveEvents.push({ eventId: "sched-1", name: "build.done", data: { step: 2 } });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls.filter((c) => c.method === "events/poll").length).toBeGreaterThan(initialPolls);
      expect(wakes).toContain("srv:event build.done");

      const drained = await tools.get("mcp_events").execute("1", { action: "poll", server: "srv" });
      expect(drained.details.events.map((e: any) => e.eventId)).toEqual(["sched-1"]);

      const pollsBeforeClose = calls.filter((c) => c.method === "events/poll").length;
      closed.abort();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls.filter((c) => c.method === "events/poll").length).toBe(pollsBeforeClose);
    } finally {
      vi.useRealTimers();
    }
  });
});
