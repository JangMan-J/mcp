import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, type Transport } from "@mcp-client/core";
import { openListenStream, ResultCache, SubscriptionManager, SUBSCRIPTION_ID, type ListenFilter, type Subscription } from "@mcp-client/mrtr-cache";
import { StdioTransport } from "@mcp-client/transport-stdio";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";

async function bounded<T>(p: PromiseLike<T>, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${operation}`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

function eventIds(listener: Subscription) {
  return bounded((async () => {
    const ids = [];
    for await (const e of listener.events) ids.push((e.params._meta as Record<string, unknown>)[SUBSCRIPTION_ID]);
    return ids;
  })(), "graceful completion");
}

function session(transport: Transport, mutant?: string) {
  let id = 0;
  const next = () => ++id;
  const client = new McpClient({ transport, server: { key: "fixture" }, idGenerator: next });
  const cache = new ResultCache();
  const open = openListenStream(transport, next);
  const manager = new SubscriptionManager({
    binding: transport.binding === "stdio" ? "stdio" : "http", serverRef: "fixture", random: () => 0,
    ...(mutant !== "skip-invalidation" && { cache }),
    open(method, params) {
      const stream = open(method, params);
      if (!mutant) return stream;
      return {
        id: stream.id,
        async *[Symbol.asyncIterator]() {
          for await (const n of stream) {
            if (mutant !== "drop-updates" || n.method === "notifications/subscriptions/acknowledged") yield n;
          }
        },
        done: stream.done.then(out => mutant === "wrong-completion-id" && out.kind === "ok"
          ? { ...out, value: { resultType: "complete", _meta: { [SUBSCRIPTION_ID]: -1 } } } : out),
        close() { if (mutant !== "omit-close") stream.close(); },
      };
    },
  });
  const listeners: Subscription[] = [];
  return {
    client, manager, cache,
    async listen(filter: ListenFilter) {
      const listener = manager.listen(filter);
      listeners.push(listener);
      await bounded(listener.acknowledged, "listen acknowledgment");
      return listener;
    },
    async close() {
      for (const l of listeners) l.close();
      await client.close();
    },
  };
}

async function stdio(action: string, mutant?: string) {
  const dir = await mkdtemp(join(tmpdir(), "sub-binding-"));
  const log = join(dir, "wire.log");
  const peer = fileURLToPath(new URL("../../fixtures/server/stdio-main.ts", import.meta.url));
  const restart = action === "stdio-restart-resend";
  const transport = new StdioTransport({ command: process.execPath,
    args: ["--no-warnings", "--experimental-strip-types", peer, "--log", log, "--mode", restart ? "subscription-crash" : "subscription"],
  });
  const s = session(transport, mutant);
  const wire = async () => (await readFile(log, "utf8")).split("\n").filter(l => l.startsWith("STDIN:")).map(l => JSON.parse(l.slice(6)));
  const filter = { resourceUris: ["file:///a.txt"] };
  try {
    const a = await s.listen(filter);
    if (restart) {
      const crash = await bounded(s.client.request("tools/call", {}), "child exit");
      assert.equal(crash.kind, "uncertain-write");
      assert.equal(a.state, "reconnecting");
      // An on-demand ping starts the replacement child. Only then signal readiness.
      assert.equal((await bounded(s.client.request("ping"), "new child ping")).kind, "ok");
      if (mutant !== "skip-resend") s.manager.reconnected();
      let resync: string | undefined;
      if (a.state !== "reconnecting") resync = (await bounded(a.events[Symbol.asyncIterator]().next(), "resync")).value?.method;
      const requests = (await wire()).filter(r => r.method === "subscriptions/listen");
      return { ids: requests.map(r => r.id), sameFilter: JSON.stringify(requests[0].params.notifications) === JSON.stringify(requests[1]?.params.notifications), resync };
    }
    if (action === "client-cancel-stdio") {
      a.close();
      // A reply to a subsequent request fences the peer's stdin log.
      assert.equal((await bounded(s.client.request("ping"), "cancel fence")).kind, "ok");
      return { reason: a.reason, cancelIds: (await wire()).filter(r => r.method === "notifications/cancelled").map(r => r.params.requestId) };
    }
    const listeners = action === "two-listeners-demux" ? [a, await s.listen(filter)] : [a];
    assert.equal((await bounded(s.client.request("ping"), "peer update and completion")).kind, "ok");
    const events = await Promise.all(listeners.map(eventIds));
    if (action === "two-listeners-demux") return { events };
    assert.equal(action, "graceful-close-stdio");
    return { reason: a.reason };
  } finally {
    try { await s.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

async function http(action: string, mutant?: string) {
  let stream: ServerResponse | undefined, cancelPosts = 0, version = 0;
  let onClose!: () => void;
  const closed = new Promise<void>(resolve => { onClose = resolve; });
  const ids: number[] = [];
  const streams = new Map<number, ServerResponse>();
  const event = (msg: object) => `data: ${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n\n`;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { method, id } = JSON.parse(Buffer.concat(chunks).toString());
    if (method === "subscriptions/listen") {
      stream = res;
      ids.push(id);
      res.once("close", onClose);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const _meta = { [SUBSCRIPTION_ID]: id };
      streams.set(id, res);
      res.write(event({ method: "notifications/subscriptions/acknowledged", params: { _meta, notifications: { toolsListChanged: true } } }));
      if (action === "graceful-close") res.end(event({ id, result: { resultType: "complete", _meta } }));
    } else if (method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", ttlMs: 60_000, cacheScope: "private", version: ++version } }));
    } else {
      if (method === "notifications/cancelled") cancelPosts++;
      res.writeHead(202).end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  assert(addr && typeof addr === "object");
  const transport = new HttpTransport({ url: `http://127.0.0.1:${addr.port}/mcp` });
  const s = session(transport, mutant);
  try {
    const l = await s.listen({ tools: true });
    const events = l.events[Symbol.asyncIterator]();
    if (action === "two-listeners-demux-http") {
      const other = await s.listen({ tools: true });
      for (const [id, res] of streams) {
        // Even a live id is invalid on the other listener's HTTP stream.
        const update = (target: number) => event({ method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID]: target } } });
        res.write(update(ids.find(n => n !== id)!));
        res.write(update(id));
        res.end(event({ id, result: { resultType: "complete", _meta: { [SUBSCRIPTION_ID]: id } } }));
      }
      return { events: await Promise.all([l, other].map(eventIds)) };
    }
    if (action === "graceful-close") {
      assert((await bounded(events.next(), "final result")).done);
      return { reason: l.reason, listens: ids.length };
    }
    if (action === "client-cancel-http") {
      l.close();
      if (mutant === "extra-cancel") await transport.notify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: l.id } }, { signal: new AbortController().signal, timeoutMs: 1000, idempotent: true });
      await bounded(closed, "server observed disconnect");
      return { reason: l.reason, socketClosed: stream?.destroyed, cancelPosts };
    }
    assert.equal(action, "http-abrupt-reconnect-invalidates-cache");
    const list = async () => {
      const out = await bounded(s.cache.run({ serverRef: "fixture", authContextId: "user" }, "tools/list", {}, {},
        async (m, p, opts) => s.client.request(m, p, opts)), "tools/list");
      assert(out.kind === "ok");
      return (out.value as {version: number}).version;
    };
    const versions = [await list(), await list()];
    stream!.destroy();
    const resync = (await bounded(events.next(), "HTTP reconnect")).value?.method;
    versions.push(await list());
    return { distinctListenIds: ids.length === 2 && ids[0] !== ids[1], versions, resync };
  } finally {
    try { await s.close(); } finally {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await stopped;
    }
  }
}

export async function runBinding(fx: ExchangeFixture, mutant?: string) {
  assert.equal(fx.script.length, 1, "expected one binding exercise");
  const action = (fx.script[0] as {do?: string}).do;
  assert(action);
  assert(fx.binding === "http" || fx.binding === "stdio");
  const actual = await (fx.binding === "http" ? http : stdio)(action, mutant);
  assert.deepEqual(actual, (fx.expect as { observe?: unknown }).observe);
}
