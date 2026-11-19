import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { McpClient, type Exchange, type RequestId, type TransportCall } from "@mcp-client/core";
import { afterEach, expect, test } from "vitest";
import { META_PROGRESS_TOKEN, META_SUBSCRIPTION_ID, StdioTransport, type StdioTransportOptions } from "../src/index.js";

const server = fileURLToPath(new URL("../../fixtures/server/stdio-main.ts", import.meta.url));
const children: Array<{ child: ChildProcess; closed: boolean; done: Promise<void> }> = [];
const transports: StdioTransport[] = [];
const dirs: string[] = [];

function launch(mode: string, options: Partial<StdioTransportOptions> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-stdio-"));
  dirs.push(dir);
  const log = join(dir, "wire.log");
  const transport = new StdioTransport({
    command: process.execPath,
    cwd: dir,
    args: ["--no-warnings", "--experimental-strip-types", server, "--log", log, "--mode", mode, ...args],
    graceMs: 150,
    termMs: 150,
    ...options,
    spawnFn(command, argv, settings) {
      const child = spawn(command, argv, settings);
      const entry = { child, closed: false, done: Promise.resolve() };
      entry.done = new Promise<void>((resolve) => child.once("close", () => {
        entry.closed = true;
        resolve();
      }));
      children.push(entry);
      return child;
    },
  });
  transports.push(transport);
  const events = () => readFileSync(log, "utf8").trimEnd().split("\n");
  const wire = () => events().filter((l) => l.startsWith("STDIN:")).map((l) => JSON.parse(l.slice(6)));
  return { transport, events, wire };
}

afterEach(async () => {
  try {
    await Promise.all(transports.map((transport) => transport.close()));
    for (const entry of children) {
      expect(entry.closed, `child ${entry.child.pid ?? "(spawn failed)"} did not close`).toBe(true);
      if (entry.child.pid !== undefined) {
        expect(() => process.kill(entry.child.pid!, 0)).toThrow(/ESRCH/);
      }
    }
  } finally {
    await Promise.all(children.map(async (entry) => {
      // Still reap a leaked child if the assertion above fails.
      if (!entry.closed) entry.child.kill("SIGKILL");
      await entry.done;
    }));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = children.length = transports.length = 0;
  }
});

function context(signal = new AbortController().signal): TransportCall {
  return { signal, idempotent: false, timeoutMs: 1000 };
}

function request(transport: StdioTransport, id: RequestId, method = "tools/list", params = {}, ctx = context()) {
  return transport.start({ jsonrpc: "2.0", id, method, params }, ctx);
}

async function notifications(exchange: Exchange) {
  const received = [];
  for await (const n of exchange.notifications) received.push(n);
  return received;
}

function clientFor(transport: StdioTransport) {
  return new McpClient({ transport, server: { key: "stdio-test" }, defaults: { timeoutMs: 1000 } });
}

test("frames split UTF-8 and CRLF; preserves escaped newlines in exactly one stdin record", async () => {
  const { transport, wire } = launch("split-multibyte", {}, ["--gated-split"]);
  const params = { name: "first\r\nsecond\u0000🌍" };
  const reply = request(transport, 7, "tools/call", params).done;
  const [head] = await once(children[0]!.child.stdout!, "data");
  expect(head.subarray(-2)).toEqual(Buffer.from([0xf0, 0x9f]));
  const release = { jsonrpc: "2.0", method: "notifications/test/continue" } as const;
  await transport.notify(release, context());
  await expect(reply).resolves.toMatchObject({
    kind: "response", message: { id: 7, result: { text: "Hello 🌍 日本語 café 🚀" } },
  });
  expect(wire()).toEqual([{ jsonrpc: "2.0", id: 7, method: "tools/call", params }, release]);
});

test("routes merged out-of-order responses and progress by typed IDs/tokens", async () => {
  const { transport } = launch("out-of-order");
  const a = request(transport, 4, "tools/list", { name: "A", _meta: { [META_PROGRESS_TOKEN]: 1 } });
  const b = request(transport, "4", "tools/list", { name: "B", _meta: { [META_PROGRESS_TOKEN]: "1" } });
  const order: string[] = [];
  void a.done.then(() => order.push("A"));
  void b.done.then(() => order.push("B"));
  await expect(a.done).resolves.toMatchObject({ message: { id: 4, result: { name: "A" } } });
  await expect(b.done).resolves.toMatchObject({ message: { id: "4", result: { name: "B" } } });
  expect(order).toEqual(["B", "A"]);
  expect((await notifications(a)).map((n) => n.params?.progressToken)).toEqual([1]);
  expect((await notifications(b)).map((n) => n.params?.progressToken)).toEqual(["1"]);
});

test("demuxes subscription notifications by listen request ID, independently of responses", async () => {
  const { transport } = launch("subscription");
  const params = { notifications: { resourceSubscriptions: ["file:///a.txt"] } };
  const numeric = request(transport, 5, "subscriptions/listen", params);
  const string = request(transport, "5", "subscriptions/listen", params);
  const list = request(transport, 6);
  await expect(list.done).resolves.toMatchObject({ message: { id: 6, result: { interleaved: true } } });
  for (const [id, exchange] of [[5, numeric], ["5", string]] as const) {
    const received = await notifications(exchange);
    expect(received.map((n) => n.method)).toEqual(["notifications/subscriptions/acknowledged", "notifications/resources/updated"]);
    expect(received.map((n) => n.params?._meta)).toEqual([{ [META_SUBSCRIPTION_ID]: id }, { [META_SUBSCRIPTION_ID]: id }]);
  }
  expect(await notifications(list)).toEqual([]);
});

test("ignores and diagnoses a server request without writing a reply; budgets repeated violations", async () => {
  const clean = launch("server-request");
  await expect(request(clean.transport, 1).done).resolves.toMatchObject({ message: { result: { afterServerReq: true } } });
  await clean.transport.close();
  expect(clean.wire()).toEqual([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  expect(clean.transport.diagnosticsSnapshot()).toContainEqual(expect.objectContaining({
    kind: "violation", message: expect.stringContaining("server-initiated request ignored"),
  }));

  const strict = launch("server-request", { maxNoiseLines: 0 });
  await expect(request(strict.transport, 1).done).resolves.toMatchObject({ failure: { message: expect.stringContaining("protocol-noise") } });
});

test("skips stdout noise within budget and fails above budget", async () => {
  const { transport } = launch("noise", { maxNoiseLines: 3 });
  await expect(request(transport, 1).done).resolves.toMatchObject({ message: { result: { afterNoise: true } } });
  await expect(request(transport, 2).done).resolves.toMatchObject({ failure: { kind: "stream-broken", message: expect.stringContaining("protocol-noise") } });
  expect(transport.state).toBe("failed");
});

test.each([
  ["oversize", { maxLineBytes: 128 }, "too-large"],
  ["batch", {}, "stream-broken"],
] as const)("rejects a %s line", async (mode, options, kind) => {
  const { transport } = launch(mode, options);
  await expect(request(transport, 1).done).resolves.toMatchObject({ kind: "failure", failure: { kind } });
});

test("skips cancelled queued work, and prioritizes cancellation behind a backpressured write", async () => {
  const { transport, wire } = launch("cancel-delay");
  const active = new AbortController();
  const queued = new AbortController();
  const a = request(transport, 1, "tools/list", { _meta: { [META_PROGRESS_TOKEN]: 1 } }, context(active.signal));
  const b = request(transport, 2, "tools/list", {}, context(queued.signal));
  queued.abort();
  await expect(b.done).resolves.toMatchObject({ kind: "failure", delivery: "not-sent" });
  const n = a.notifications[Symbol.asyncIterator]();
  await expect(n.next()).resolves.toMatchObject({ value: { method: "notifications/progress" } });
  const large = request(transport, 3, "tools/list", { text: "x".repeat(512 * 1024) });
  const tail = request(transport, 4);
  active.abort("stop");
  await expect(a.done).resolves.toMatchObject({ kind: "failure", delivery: "delivered-no-response" });
  await expect(large.done).resolves.toMatchObject({ kind: "response", message: { id: 3 } });
  await expect(tail.done).resolves.toMatchObject({ kind: "response", message: { id: 4 } });
  expect(wire().map(({ method, id, params }) => [method, id ?? params.requestId])).toEqual([
    ["tools/list", 1], ["tools/list", 3], ["notifications/cancelled", 1], ["tools/list", 4],
  ]);
  expect(transport.diagnosticsSnapshot()).toContainEqual(expect.objectContaining({ message: expect.stringContaining("duplicate-or-late-response") }));
});

test.skipIf(process.platform === "win32")("waits in real time between stdin EOF, SIGTERM, and SIGKILL, sharing concurrent close", async () => {
  let virtualTimers = 0;
  const { transport, events } = launch("ignore-stdin-close", {
    graceMs: 200,
    termMs: 200,
    clock: { now: () => 123, setTimeout: (fn, ms) => {
      virtualTimers++;
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    } },
  }, ["--ignore-sigterm"]);
  await expect(request(transport, 1).done).resolves.toMatchObject({ kind: "response" });
  const start = Date.now();
  const t0 = performance.now();
  const close = transport.close();
  expect(transport.close()).toBe(close);
  await close;
  const [eof, term] = events().slice(1);
  expect(eof).toBe("STDIN_EOF");
  expect(term).toMatch(/^SIGNAL:SIGTERM:\d+$/);
  const elapsedToTerm = Number(term!.split(":")[2]) - start;
  expect(elapsedToTerm).toBeGreaterThanOrEqual(190);
  expect(performance.now() - t0 - elapsedToTerm).toBeGreaterThanOrEqual(170);
  expect(virtualTimers).toBe(0);
  expect(children[0]?.child.signalCode).toBe("SIGKILL");
});

test("captures stderr separately and bounds its line and total size", async () => {
  const { transport } = launch("stderr", { stderrMaxBytes: 27, stderrMaxLineBytes: 10 }, ["--long-stderr"]);
  await expect(request(transport, 1).done).resolves.toMatchObject({ message: { result: { stderrEmitted: true } } });
  await transport.close();
  expect(transport.stderrSnapshot()).toEqual(["stderr-inf", "EEEEEEEEEE"]);
  expect(transport.diagnosticsSnapshot().filter((d) => d.kind === "stderr").map((d) => d.message)).toEqual(["stderr-inf", "stderr-inf", "EEEEEEEEEE"]);
});

test("does not retain an unbounded number of empty stderr lines", async () => {
  const { transport } = launch("stderr-empty", { stderrMaxBytes: 5 });
  await expect(request(transport, 1).done).resolves.toMatchObject({ kind: "response" });
  await transport.close();
  expect(transport.stderrSnapshot()).toEqual(["", "", "", "", ""]);
});

test("classifies a crashed side effect as uncertain and restarts on demand without replay", async () => {
  const { transport, wire } = launch("crash-on-request", {}, ["--partial"]);
  const client = clientFor(transport);
  await expect(Promise.resolve(client.request("tools/call", { name: "side-effect" }))).resolves.toMatchObject({
    kind: "uncertain-write", uncertain: { method: "tools/call", binding: "stdio", evidence: "process-exit" }, meta: { attempts: 1 },
  });
  expect(wire().map((m) => m.method)).toEqual(["tools/call"]);
  expect(transport.state).toBe("idle");
  expect(transport.diagnosticsSnapshot()).toContainEqual(expect.objectContaining({ message: expect.stringContaining("eof-mid-line") }));
  await expect(Promise.resolve(client.request("tools/list", {}, { idempotent: true }))).resolves.toMatchObject({
    kind: "transport-failure", safeToRetry: true, failure: { kind: "process-exit" },
  });
  expect(wire().map((m) => m.method)).toEqual(["tools/call", "tools/list"]);
  expect(children).toHaveLength(2);
});

test("settles requests on stdout EOF even if the process stays alive", async () => {
  const { transport } = launch("stdout-eof");
  const out = await Promise.resolve(clientFor(transport).request("tools/list", {}, { idempotent: true, timeoutMs: 350 }));
  expect(out).toMatchObject({ kind: "transport-failure", safeToRetry: true, failure: { kind: "process-exit" } });
});

test("limits automatic restarts without replaying a lost exchange", async () => {
  const { transport, wire } = launch("crash-on-request", { restart: { policy: "auto", backoffMs: 5, maxRestarts: 1 } });
  await expect(request(transport, 1).done).resolves.toMatchObject({ failure: { kind: "process-exit" } });
  await expect.poll(() => transport.state).toBe("ready");
  expect(children).toHaveLength(2);
  expect(wire().map((m) => m.id)).toEqual([1]);
  await expect(request(transport, 2).done).resolves.toMatchObject({ failure: { kind: "process-exit" } });
  await expect(request(transport, 3).done).resolves.toMatchObject({
    delivery: "not-sent", failure: { message: expect.stringContaining("Restart loop guard") },
  });
  expect(wire().map((m) => m.id)).toEqual([1, 2]);
});

test("ends a lost listen and allows caller-driven discovery and a new listen without replay", async () => {
  const { transport, wire } = launch("subscription-crash");
  const listen = (id: number) => request(transport, id, "subscriptions/listen", {
    notifications: { resourceSubscriptions: ["file:///a.txt"] },
  });
  const first = listen(10);
  const stream = first.notifications[Symbol.asyncIterator]();
  await expect(stream.next()).resolves.toMatchObject({ value: { method: "notifications/subscriptions/acknowledged" } });
  await expect(request(transport, 11, "tools/call", { name: "crash" }).done).resolves.toMatchObject({
    kind: "failure", delivery: "delivered-no-response", failure: { kind: "process-exit" },
  });
  await expect(first.done).resolves.toMatchObject({ kind: "failure", failure: { kind: "process-exit" } });
  await expect(stream.next()).resolves.toMatchObject({ done: true });
  await expect(request(transport, 12, "server/discover").done).resolves.toMatchObject({
    message: { result: { supportedVersions: ["2026-07-28"] } },
  });
  const next = listen(13);
  await expect(next.notifications[Symbol.asyncIterator]().next()).resolves.toMatchObject({
    value: { params: { _meta: { [META_SUBSCRIPTION_ID]: 13 } } },
  });
  expect(wire().map((m) => [m.method, m.id])).toEqual([
    ["subscriptions/listen", 10], ["tools/call", 11], ["server/discover", 12], ["subscriptions/listen", 13],
  ]);
});

test("reports asynchronous spawn failure as not sent", async () => {
  const { transport } = launch("echo", { command: "./not-a-real-command" });
  await expect(request(transport, 1).done).resolves.toMatchObject({
    kind: "failure", delivery: "not-sent", failure: { kind: "spawn", message: expect.stringContaining("ENOENT") },
  });
});

test("launch is lazy, arguments are literal, and explicit discover never sends initialize", async () => {
  const { transport, wire, events } = launch("echo", {}, ["argument; exit 77"]);
  expect(children).toHaveLength(0);
  await expect(Promise.resolve(clientFor(transport).discover())).resolves.toMatchObject({ kind: "ok", value: { supportedVersions: ["2026-07-28"] } });
  await transport.close();
  expect(wire().map((m) => m.method)).toEqual(["server/discover"]);
  expect(events()).toHaveLength(2);
  expect(events()[1]).toBe("STDIN_EOF");
  expect(children[0]?.child.exitCode).toBe(0);
});
