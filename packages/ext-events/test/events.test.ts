import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import {
  McpClient,
  NotificationQueue,
  createMonotonicIdGenerator,
  type Clock,
  type ExchangeEnd,
  type JsonRpcNotification,
  type Transport,
} from "@mcp-client/core";
import { StdioTransport } from "@mcp-client/transport-stdio";
import {
  EVENTS_EXTENSION_ID,
  EventsClient,
  EventsExtension,
  createEventsExtension,
  openEventsStream,
  type PushMessage,
} from "../src/index.js";

function makeManualClock(start = 1000) {
  let now = start;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let seq = 0;
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    now = target;
  };
  return { clock, advance };
}

describe("@mcp-client/ext-events", () => {
  it("routes a live stdio Events frame and cancels its request id on the wire", async () => {
    let ack!: (line: string) => void;
    const cancelled = new Promise<string>((r) => {
      ack = r;
    });
    const transport = new StdioTransport({
      command: process.execPath,
      args: [
        "-e",
        `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const m=JSON.parse(line);
        if(m.method==='events/stream') console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/events/active',params:{heartbeatMs:50,_meta:{'io.modelcontextprotocol/subscriptionId':m.id}}}));
        if(m.method==='notifications/cancelled') console.error('cancelled:'+m.params.requestId);
      });`,
      ],
      onStderr: ack,
    });
    try {
      const open = openEventsStream(
        transport,
        () => 17,
        () => ({}),
      );
      const stream = open(
        "events/stream",
        { name: "mail", cursor: null },
        { headersHint: { name: "mail" } },
      );
      const first = await stream[Symbol.asyncIterator]().next();
      expect(first.value.method).toBe("notifications/events/active");
      stream.close();
      expect(await cancelled).toContain("cancelled:17");
    } finally {
      await transport.close();
    }
  });

  it("registers io.modelcontextprotocol/events capability only when enabled and healthy", async () => {
    const disabled = createEventsExtension();
    expect(disabled).toBeInstanceOf(EventsExtension);
    expect(disabled.id).toBe(EVENTS_EXTENSION_ID);
    expect(disabled.health()).toBe("unavailable");
    expect(disabled.settings()).toBeUndefined();
    expect(disabled.capabilities(true)).toEqual({});

    const unhealthy = createEventsExtension({ enabled: true, healthy: false });
    expect(unhealthy.health()).toBe("unavailable");
    expect(unhealthy.capabilities(true)).toEqual({});

    const enabled = createEventsExtension({ enabled: true });
    expect(enabled.health()).toBe("working");
    expect(enabled.settings()).toEqual({});
    expect(enabled.capabilities(true)).toEqual({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
    expect(enabled.capabilities(false)).toEqual({});

    const seenCaps: unknown[] = [];
    const transport: Transport = {
      binding: "stdio",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg) {
        seenCaps.push((msg.params?._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"]);
        return {
          notifications: { async *[Symbol.asyncIterator]() {} },
          done: Promise.resolve({ kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: {} } }),
        };
      },
    };
    const core = new McpClient({ transport, server: { key: "ev" }, extensions: [enabled] });
    await core.request("ping", {});
    expect(seenCaps[0]).toEqual({ extensions: { [EVENTS_EXTENSION_ID]: {} } });
    await core.close();
  });

  it("keeps inbound listeners outside the runtime and makes no unconditional delivery guarantee", () => {
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8");
    const files = readdirSync(new URL("../src/", import.meta.url), {
      recursive: true,
    }).filter((f) => typeof f === "string" && f.endsWith(".ts"));
    for (const f of files)
      expect(read("../src/" + f)).not.toMatch(
        /node:(http2?|https|net|tls|dgram)|createServer|\.listen\s*\(|exactly-once/i,
      );
    expect(read("../README.md")).not.toMatch(/exactly-once/i);
  });

  it("gates list/poll on capabilities, advances cursors, deduplicates events, and computes poll delay", async () => {
    const sent: Array<{ method: string; params: Record<string, unknown>; name?: string }> = [];
    let nextReply: Record<string, unknown> = {};
    const transport: Transport = {
      binding: "streamable-http",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg, ctx) {
        const { _meta, ...rest } = msg.params ?? {};
        void _meta;
        sent.push({
          method: msg.method,
          params: rest,
          ...(ctx.headersHint?.name ? { name: ctx.headersHint.name } : {}),
        });
        return {
          notifications: { async *[Symbol.asyncIterator]() {} },
          done: Promise.resolve({
            kind: "response",
            message: { jsonrpc: "2.0", id: msg.id, result: structuredClone(nextReply) },
          }),
        };
      },
    };
    const core = new McpClient({ transport, server: { key: "ev-poll" } });
    let peerCaps: Record<string, unknown> = {};
    const ext = createEventsExtension({ enabled: true });
    const client = new EventsClient({
      extension: ext,
      peerCapabilities: () => peerCaps,
      request: (m, p, o) => core.request(m, p, o),
    });

    await expect(client.list()).rejects.toThrow("Events unavailable");
    expect(sent).toHaveLength(0);

    peerCaps = { extensions: { [EVENTS_EXTENSION_ID]: { revision: "2026-07-28", listChanged: true } } };
    expect(client.expectsListChanged()).toBe(true);

    nextReply = { events: [{ name: "mail" }], nextCursor: "p2" };
    const listed = await client.list();
    expect(listed).toEqual({ events: [{ name: "mail" }], nextCursor: "p2" });

    const subId = client.subscription("mail", { folder: "inbox" });
    nextReply = {
      events: [
        { eventId: "e1", name: "mail", timestamp: "2026-01-01T00:00:00Z", data: { n: 1 }, cursor: "c1" },
        { eventId: "e1", name: "mail", timestamp: "2026-01-01T00:00:00Z", data: { n: 1 }, cursor: "c1" },
      ],
      cursor: "c2",
      truncated: true,
      hasMore: true,
      nextPollMs: 5000,
    };
    const p1 = await client.poll(subId);
    expect(p1.events).toHaveLength(1);
    expect(p1.cursor).toBe("c2");
    expect(p1.truncated).toBe(true);
    expect(p1.gap).toBe(true);
    expect(p1.nextDelayMs).toBe(0);

    nextReply = { events: [], cursor: "c3", hasMore: false, nextPollMs: 250 };
    const p2 = await client.poll(subId);
    expect(p2.nextDelayMs).toBe(1000);
    expect(sent[2]).toEqual({
      method: "events/poll",
      params: { name: "mail", arguments: { folder: "inbox" }, cursor: "c2" },
      name: "mail",
    });

    client.dispose();
    await core.close();
  });

  it("streams push events via watchStream, reconnects on heartbeat expiry, and stops on terminated/close", async () => {
    const { clock, advance } = makeManualClock();
    const queues: NotificationQueue<JsonRpcNotification>[] = [];
    const aborts: number[] = [];
    const nextId = createMonotonicIdGenerator();
    const transport: Transport = {
      binding: "streamable-http",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg, ctx) {
        const q = new NotificationQueue<JsonRpcNotification>();
        queues.push(q);
        const done = new Promise<ExchangeEnd>((resolve) => {
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborts.push(clock.now());
              q.close();
              resolve({ kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: {} } });
            },
            { once: true },
          );
        });
        return { notifications: q, done };
      },
    };
    const core = new McpClient({ transport, server: { key: "ev-push" } });
    const ext = createEventsExtension({ enabled: true });
    const client = new EventsClient({
      extension: ext,
      clock,
      jitterMs: () => 25,
      peerCapabilities: () => ({ extensions: { [EVENTS_EXTENSION_ID]: {} } }),
      request: (m, p, o) => core.request(m, p, o),
      openStream: openEventsStream(transport, nextId, () => ext.capabilities(true)),
    });

    const subId = client.subscription("mail");
    const delivered: PushMessage[] = [];
    const handle = client.push(subId, (m) => delivered.push(m));
    await new Promise((r) => setImmediate(r));

    queues[0]!.push({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { heartbeatMs: 100, cursor: "c0", _meta: { "io.modelcontextprotocol/subscriptionId": 1 } },
    });
    queues[0]!.push({
      jsonrpc: "2.0",
      method: "notifications/events/event",
      params: {
        eventId: "e1",
        name: "mail",
        timestamp: "2026-01-01T00:00:00Z",
        data: { subject: "hi" },
        cursor: "c1",
        _meta: { "io.modelcontextprotocol/subscriptionId": 1 },
      },
    });
    await new Promise((r) => setImmediate(r));

    // Expire heartbeat (100ms) + jitter (25ms) -> reconnects with stream id 2.
    await advance(130);
    expect(aborts).toEqual([1100]);
    expect(queues).toHaveLength(2);

    queues[1]!.push({
      jsonrpc: "2.0",
      method: "notifications/events/active",
      params: { heartbeatMs: 100, cursor: "c1", _meta: { "io.modelcontextprotocol/subscriptionId": 2 } },
    });
    queues[1]!.push({
      jsonrpc: "2.0",
      method: "notifications/events/terminated",
      params: { error: "done", _meta: { "io.modelcontextprotocol/subscriptionId": 2 } },
    });
    await new Promise((r) => setImmediate(r));

    expect(delivered.map((d) => d.type)).toEqual(["active", "event", "active", "terminated"]);
    handle.close();
    client.dispose();
    await core.close();
  });

  it("enforces webhook opt-in, endpoint validation, refresh scheduling, and unsubscribe", async () => {
    const { clock, advance } = makeManualClock(0);
    const calls: string[] = [];
    const transport: Transport = {
      binding: "streamable-http",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg) {
        calls.push(msg.method);
        const result =
          msg.method === "events/subscribe"
            ? { cursor: "w1", refreshBefore: new Date(clock.now() + 1000).toISOString() }
            : {};
        return {
          notifications: { async *[Symbol.asyncIterator]() {} },
          done: Promise.resolve({ kind: "response", message: { jsonrpc: "2.0", id: msg.id, result } }),
        };
      },
    };
    const core = new McpClient({ transport, server: { key: "ev-wh" } });
    const ext = createEventsExtension({ enabled: true });
    let enableWebhook = false;
    const endpoint = {
      url: "https://hooks.example.com/mcp",
      secret: "whsec_AAAA",
      isReady: () => true,
    };
    const client = new EventsClient({
      extension: ext,
      clock,
      peerCapabilities: () => ({ extensions: { [EVENTS_EXTENSION_ID]: {} } }),
      request: (m, p, o) => core.request(m, p, o),
      get enableWebhook() {
        return enableWebhook;
      },
      endpoint,
    });

    const id = client.subscription("mail");
    await expect(client.subscribe(id)).rejects.toThrow("Webhook unavailable");

    enableWebhook = true;
    const sub = await client.subscribe(id);
    expect(sub.cursor).toBe("w1");
    expect(calls).toEqual(["events/subscribe"]);

    await advance(850);
    expect(calls).toEqual(["events/subscribe", "events/subscribe"]);

    await client.unsubscribe(id);
    expect(calls).toEqual(["events/subscribe", "events/subscribe", "events/unsubscribe"]);
    expect(client.subscriptions()).toEqual([]);

    client.dispose();
    await core.close();
  });
});
