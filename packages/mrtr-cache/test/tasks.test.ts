import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  ExtensionRegistry,
  McpClient,
  NotificationQueue,
  type ExchangeEnd,
  type JsonRpcNotification,
  type Outcome,
  type StreamHandle,
  type Transport,
} from "@mcp-client/core";
import {
  createTasksExtension,
  MemoryTaskStore,
  TaskHandle,
  TASKS_ID,
  type TaskState,
} from "../src/index.js";

const path = (p: string) => new URL(p, import.meta.url);
const text = (p: string) => readFileSync(path(p), "utf8");
const meta = { requestId: 1, method: "tasks/get", binding: "test", attempts: 1 };

it("EXT-REG-1: importing never registers an extension", async () => {
  vi.resetModules();
  const { ExtensionRegistry: Registry } = await import("@mcp-client/core");
  const spy = vi.spyOn(Registry.prototype, "register");
  try {
    await import("../src/index.js");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it("EXT-PORT-1: extension-owned store isolates server namespaces", () => {
  const store = new MemoryTaskStore();
  for (const serverKey of ["a", "b"]) {
    store.put({ serverKey, taskId: "x", createdAt: 5, lastStatus: "working" });
  }
  store.delete("a", "x");
  expect(store.list("a")).toEqual([]);
  expect(store.get("b", "x")?.createdAt).toBe(5);
});

it("EXT-STREAM-1: runtime depends on public ports, not transports or extensions", () => {
  for (const f of readdirSync(path("../src/"))) {
    for (const m of text("../src/" + f).matchAll(/from ['"]([^'"]+)['"]/g)) {
      expect(m[1]).toMatch(/^(?:\.\/|node:|@mcp-client\/core$)/);
    }
  }
});

it("rejects malformed task results before persisting", () => {
  const registry = new ExtensionRegistry();
  const ext = createTasksExtension({
    peerCapabilities: { extensions: { [TASKS_ID]: {} } },
  });
  registry.register(ext);
  const accept = registry.resolveResultType("task")!;
  for (const field of [
    { taskId: "" },
    { status: "done" },
    { ttl: -1 },
    { pollIntervalMs: Infinity },
    { inputRequests: [] },
    { error: 1 },
    { result: false },
  ]) {
    expect(accept({ taskId: "x", status: "working", ...field }).kind).toBe("protocol-violation");
  }
  expect(ext.resumeAll()).toEqual([]);
});

describe("push-first tasks runtime", () => {
  it("TaskHandle.get() sends tasks/get immediately without sleeping on pollIntervalMs", async () => {
    const timers: number[] = [];
    const request = vi.fn(async () => ({
      kind: "ok" as const,
      value: { resultType: "task", taskId: "t1", status: "completed", result: { ok: true } },
      meta,
    }));
    const ext = createTasksExtension({
      peerCapabilities: { extensions: { [TASKS_ID]: {} } },
      clock: {
        now: () => 0,
        setTimeout: (_fn, ms) => {
          timers.push(ms);
          return () => {};
        },
      },
      request,
    });
    const accepted = ext.accept({
      resultType: "task",
      taskId: "t1",
      status: "working",
      pollIntervalMs: 5000,
    });
    if (accepted.kind !== "task-handle") throw Error(accepted.kind);
    const out = await (accepted.handle as TaskHandle).get();
    expect(out.kind).toBe("ok");
    expect(request).toHaveBeenCalledTimes(1);
    expect(timers).toEqual([]);
  });

  it("wakes TasksRuntime.wait(id) immediately on notifications/tasks via listen(stream) even when pollIntervalMs is set", async () => {
    let timerCleared = false;
    const ext = createTasksExtension({
      peerCapabilities: { extensions: { [TASKS_ID]: {} } },
      clock: {
        now: () => 0,
        setTimeout: () => () => {
          timerCleared = true;
        },
      },
    });
    ext.accept({
      resultType: "task",
      taskId: "t-push",
      status: "working",
      pollIntervalMs: 60_000,
    });

    const queue = new NotificationQueue<JsonRpcNotification>();
    const stream: StreamHandle = {
      id: 1,
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      done: Promise.resolve({ kind: "ok", value: {}, meta }),
      close: () => queue.close(),
    };
    const listening = ext.listen(stream);

    let resolved = false;
    const waiting = ext.wait("t-push").then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    queue.push({
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: { taskId: "t-push", status: "completed", result: { value: 7 } },
    });
    await waiting;
    expect(resolved).toBe(true);
    expect(timerCleared).toBe(true);
    queue.close();
    await listening;
  });

  it("TaskHandle.watch() yields push updates via TasksExtension onNotification without polling tasks/get", async () => {
    const queue = new NotificationQueue<JsonRpcNotification>();
    let resolveDone!: (end: ExchangeEnd) => void;
    const sentMethods: string[] = [];
    const transport: Transport = {
      binding: "stdio",
      diagnostics: new NotificationQueue(),
      start(msg) {
        sentMethods.push(msg.method);
        if (msg.method === "subscriptions/listen") {
          return { notifications: queue, done: new Promise<ExchangeEnd>((r) => (resolveDone = r)) };
        }
        const empty = new NotificationQueue<JsonRpcNotification>();
        empty.close();
        return {
          notifications: empty,
          done: Promise.resolve({
            kind: "response",
            message: {
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                resultType: "task",
                taskId: "job-1",
                status: "working",
                pollIntervalMs: 5000,
              },
            },
          }),
        };
      },
      async notify() {},
      async close() {},
    };

    const ext = createTasksExtension({
      peerCapabilities: { extensions: { [TASKS_ID]: {} } },
      request: (m, p, o) => client.request(m, p, o) as PromiseLike<Outcome<unknown>>,
    });
    const client = new McpClient({
      transport,
      server: { key: "s" },
      extensions: [ext],
    });

    const listenReq = client.request("subscriptions/listen", { notifications: {} });
    const callOut = await client.request("tools/call", { name: "long-job" });
    if (callOut.kind !== "task-handle") throw Error(callOut.kind);
    const handle = callOut.handle as TaskHandle;

    const states: TaskState[] = [];
    const watching = (async () => {
      for await (const s of handle.watch()) {
        states.push(s);
      }
    })();

    await new Promise((r) => setImmediate(r));
    queue.push({
      jsonrpc: "2.0",
      method: "notifications/tasks",
      params: { taskId: "job-1", status: "completed", result: { answer: 42 } },
    });
    await watching;

    expect(states.map((s) => s.status)).toEqual(["working", "completed"]);
    expect(states[1]).toMatchObject({ taskId: "job-1", status: "completed", result: { answer: 42 } });
    // Zero tasks/get polling requests sent when push updates arrive.
    expect(sentMethods).toEqual(["subscriptions/listen", "tools/call"]);

    resolveDone({ kind: "response", message: { jsonrpc: "2.0", id: listenReq.id, result: {} } });
    await listenReq;
    await client.close();
  });

  it("TaskHandle.watch({ fallbackPoll: true }) uses tasks/get only initially (if unknown) or on fallback interval", async () => {
    vi.useFakeTimers();
    try {
      const replies: TaskState[] = [
        { taskId: "t-fb", status: "working", pollIntervalMs: 50 },
        { taskId: "t-fb", status: "completed", result: { ok: true } },
      ];
      const request = vi.fn(async () => ({
        kind: "ok" as const,
        value: replies.shift()!,
        meta,
      }));
      const ext = createTasksExtension({
        peerCapabilities: { extensions: { [TASKS_ID]: {} } },
        request,
      });
      const handle = ext.resume("t-fb");
      const states: TaskState[] = [];
      const watching = (async () => {
        for await (const s of handle.watch({ fallbackPoll: true })) {
          states.push(s);
        }
      })();
      // Initial fetch for resumed handle with no cached state
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(1);
      // Fallback poll after pollIntervalMs = 50ms
      await vi.advanceTimersByTimeAsync(50);
      await watching;
      expect(request).toHaveBeenCalledTimes(2);
      expect(states.map((s) => s.status)).toEqual(["working", "completed"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("TaskHandle.update() propagates caller AbortSignal into elicit()", async () => {
    let observedSignal: AbortSignal | undefined;
    let enterForm!: () => void;
    const entered = new Promise<void>((r) => (enterForm = r));
    const request = vi.fn(async () => ({
      kind: "ok" as const,
      value: { resultType: "task", taskId: "t-elicit", status: "completed" },
      meta,
    }));
    const ext = createTasksExtension({
      peerCapabilities: { extensions: { [TASKS_ID]: {} } },
      request,
      elicitation: {
        serverLabel: "s",
        port: {
          form: (_req, signal) => {
            observedSignal = signal;
            enterForm();
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
      },
    });
    const accepted = ext.accept({
      resultType: "task",
      taskId: "t-elicit",
      status: "input_required",
      inputRequests: {
        confirm: {
          method: "elicitation/create",
          params: {
            message: "Proceed?",
            requestedSchema: { type: "object", properties: {} },
          },
        },
      },
    });
    if (accepted.kind !== "task-handle") throw Error(accepted.kind);
    const ac = new AbortController();
    const pending = (accepted.handle as TaskHandle).update(undefined, { signal: ac.signal });
    await entered;
    expect(observedSignal).toBe(ac.signal);
    expect(observedSignal?.aborted).toBe(false);
    ac.abort("user-cancelled");
    const out = await pending;
    expect(observedSignal?.aborted).toBe(true);
    expect(out).toMatchObject({ kind: "cancelled", wasSent: false, phase: "input" });
    expect(request).not.toHaveBeenCalled();
  });
});
