import {
  McpOutcomeError,
  NotificationQueue,
  systemClock,
  type Clock,
  type Disposable,
  type Extension,
  type ExtensionCapabilities,
  type ExtensionHost,
  type JsonRpcNotification,
  type Outcome,
  type StreamHandle,
} from "@mcp-client/core";
import { object, type Obj, type RequestFn } from "./common.js";
import { elicit, type ElicitationOptions } from "./elicitation.js";

export const TASKS_ID = "io.modelcontextprotocol/tasks";
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  readonly serverKey: string;
  readonly taskId: string;
  readonly createdAt: number;
  readonly lastStatus: TaskStatus;
  readonly ttlMs?: number;
  readonly pollIntervalMs?: number;
}

export interface TaskStore {
  put(record: TaskRecord): void;
  get(serverKey: string, taskId: string): TaskRecord | undefined;
  list(serverKey: string): readonly TaskRecord[];
  delete(serverKey: string, taskId: string): void;
}

export class MemoryTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>();
  put(r: TaskRecord) {
    this.records.set(JSON.stringify([r.serverKey, r.taskId]), { ...r });
  }
  get(s: string, t: string) {
    return this.records.get(JSON.stringify([s, t]));
  }
  list(s: string) {
    return [...this.records.values()].filter((r) => r.serverKey === s);
  }
  delete(s: string, t: string) {
    this.records.delete(JSON.stringify([s, t]));
  }
}

export interface TaskState extends Obj {
  taskId: string;
  status: TaskStatus;
  ttl?: number | null;
  ttlMs?: number;
  pollIntervalMs?: number;
  inputRequests?: Record<string, { method: string; params: Obj }>;
}

const duration = (n: unknown) =>
  n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);

function valid(x: unknown): x is TaskState {
  return (
    object(x) &&
    typeof x.taskId === "string" &&
    x.taskId.trim().length > 0 &&
    ["working", "input_required", "completed", "failed", "cancelled"].includes(String(x.status)) &&
    (x.ttl === null || duration(x.ttl)) &&
    duration(x.ttlMs) &&
    duration(x.pollIntervalMs) &&
    (x.result === undefined || object(x.result)) &&
    (x.error === undefined || object(x.error)) &&
    (x.inputRequests === undefined ||
      (object(x.inputRequests) &&
        Object.values(x.inputRequests).every(
          (v) => object(v) && typeof v.method === "string" && object(v.params),
        )))
  );
}

function isTerminal(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function extractSignal(opts?: { signal?: AbortSignal } | AbortSignal): AbortSignal | undefined {
  if (!opts) return undefined;
  return opts instanceof AbortSignal ? opts : opts.signal;
}

export interface TasksOptions {
  serverKey?: string;
  store?: TaskStore;
  clock?: Clock;
  healthy?: boolean;
  force?: boolean;
  peerCapabilities?: Obj | (() => Obj);
  elicitation?: ElicitationOptions;
  request?: RequestFn;
}

const meta = (method: string) => ({
  requestId: 0,
  method,
  binding: "extension",
  attempts: 0,
});

const violation = (method: string, detail: string): Outcome<unknown> => ({
  kind: "protocol-violation",
  detail,
  meta: meta(method),
});

export class TasksRuntime {
  readonly store: TaskStore;
  readonly serverKey: string;
  readonly clock: Clock;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly watchers = new Map<string, Set<(update: TaskState | undefined) => void>>();
  private readonly states = new Map<string, TaskState>();

  constructor(readonly opts: TasksOptions = {}) {
    this.store = opts.store ?? new MemoryTaskStore();
    this.serverKey = opts.serverKey ?? "default";
    this.clock = opts.clock ?? systemClock;
  }

  refusal(method: string): Outcome<unknown> | undefined {
    const absent = (): Outcome<unknown> => ({
      kind: "capability-absent",
      detail: TASKS_ID,
      meta: meta(method),
    });
    if (this.opts.healthy === false) return absent();
    const caps =
      typeof this.opts.peerCapabilities === "function"
        ? this.opts.peerCapabilities()
        : this.opts.peerCapabilities;
    const exts = caps?.extensions;
    if (exts !== undefined && !object(exts)) return violation(method, "invalid extensions");
    if (!exts || !Object.hasOwn(exts, TASKS_ID)) return this.opts.force ? undefined : absent();
    const s = exts[TASKS_ID];
    if (
      !object(s) ||
      Object.keys(s).some((k) => k !== "revision") ||
      ("revision" in s && typeof s.revision !== "string")
    ) {
      return violation(method, "invalid task settings");
    }
    if (s.revision !== undefined && s.revision !== "2026-07-28") return absent();
    return undefined;
  }

  remember(s: TaskState) {
    this.states.set(s.taskId, structuredClone(s));
    const old = this.store.get(this.serverKey, s.taskId);
    const ttl = s.ttl === null ? undefined : s.ttlMs ?? s.ttl ?? old?.ttlMs;
    const interval = s.pollIntervalMs ?? old?.pollIntervalMs;
    this.store.put({
      serverKey: this.serverKey,
      taskId: s.taskId,
      createdAt: old?.createdAt ?? this.clock.now(),
      lastStatus: s.status,
      ...(ttl !== undefined && { ttlMs: ttl }),
      ...(interval !== undefined && { pollIntervalMs: interval }),
    });
  }

  latestState(id: string): TaskState | undefined {
    return this.states.get(id);
  }

  emitUpdate(state: TaskState): void {
    const group = this.watchers.get(state.taskId);
    if (!group) return;
    const snapshot = structuredClone(state);
    for (const fn of [...group]) fn(snapshot);
  }

  subscribe(id: string, fn: (update: TaskState | undefined) => void): () => void {
    let group = this.watchers.get(id);
    if (!group) {
      group = new Set();
      this.watchers.set(id, group);
    }
    group.add(fn);
    return () => {
      const cur = this.watchers.get(id);
      if (!cur) return;
      cur.delete(fn);
      if (cur.size === 0) this.watchers.delete(id);
    };
  }

  accept(s: Obj): Outcome<unknown> {
    const refused = this.refusal("task");
    if (refused) return refused;
    if (!valid(s)) return violation("task", "invalid CreateTaskResult");
    const cloned = structuredClone(s);
    this.remember(cloned);
    return {
      kind: "task-handle",
      handle: new TaskHandle(this, cloned.taskId, cloned),
      meta: meta("task"),
    };
  }

  resume(id: string) {
    return new TaskHandle(this, id, this.states.get(id));
  }

  resumeAll() {
    return this.store.list(this.serverKey).map((r) => this.resume(r.taskId));
  }

  wait(id: string, opts?: { signal?: AbortSignal }): Promise<void> {
    if (opts?.signal?.aborted) return Promise.resolve();
    const interval = this.store.get(this.serverKey, id)?.pollIntervalMs;
    return new Promise((resolve) => {
      const group = this.listeners.get(id) ?? new Set<() => void>();
      this.listeners.set(id, group);
      let clear = () => {};
      let done = false;
      const onAbort = () => finish();
      const finish = () => {
        if (done) return;
        done = true;
        clear();
        opts?.signal?.removeEventListener("abort", onAbort);
        group.delete(finish);
        if (!group.size) this.listeners.delete(id);
        resolve();
      };
      group.add(finish);
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      clear = this.clock.setTimeout(finish, interval ?? 1000);
    });
  }

  notify(n: JsonRpcNotification): void {
    if (
      n.method !== "notifications/tasks" ||
      !object(n.params) ||
      typeof n.params.taskId !== "string"
    ) {
      return;
    }
    const taskId = n.params.taskId;
    let state: TaskState | undefined;
    if (valid(n.params)) {
      state = structuredClone(n.params);
      this.remember(state);
    }
    const watchGroup = this.watchers.get(taskId);
    if (watchGroup) {
      for (const fn of [...watchGroup]) fn(state ? structuredClone(state) : undefined);
    }
    const waitGroup = this.listeners.get(taskId);
    if (waitGroup) {
      for (const fn of [...waitGroup]) fn();
    }
  }

  async listen(stream: StreamHandle) {
    for await (const n of stream) {
      this.notify(n);
    }
  }
}

export class TaskHandle {
  constructor(
    readonly runtime: TasksRuntime,
    readonly id: string,
    private state?: TaskState,
  ) {}

  private currentState(): TaskState | undefined {
    return this.runtime.latestState(this.id) ?? this.state;
  }

  status() {
    return (
      this.currentState()?.status ??
      this.runtime.store.get(this.runtime.serverKey, this.id)?.lastStatus
    );
  }

  private async send(
    method: string,
    extra: Obj = {},
    opts?: { signal?: AbortSignal; notifyWatchers?: boolean },
  ): Promise<Outcome<unknown>> {
    const rt = this.runtime;
    const denied = rt.refusal(method);
    if (denied) return denied;
    if (!rt.opts.request) return violation(method, "task request port missing");
    const out = await rt.opts.request(
      method,
      { taskId: this.id, ...extra },
      {
        headersHint: { name: this.id },
        idempotent: method === "tasks/get",
        ...(opts?.signal ? { signal: opts.signal } : {}),
      },
    );
    const s =
      out.kind === "task-handle" && out.handle instanceof TaskHandle
        ? out.handle.state
        : out.kind === "ok"
          ? out.value
          : undefined;
    if (out.kind !== "ok" && out.kind !== "task-handle") return out;
    if (!valid(s) || s.taskId !== this.id) return violation(method, "invalid task response");
    const cloned = structuredClone(s);
    this.state = cloned;
    rt.remember(cloned);
    if (opts?.notifyWatchers) rt.emitUpdate(cloned);
    return { kind: "ok", value: cloned, meta: out.meta };
  }

  /** Fetches the current task state immediately on demand without pre-sleeping. */
  get(opts?: { signal?: AbortSignal } | AbortSignal): Promise<Outcome<unknown>> {
    const signal = extractSignal(opts);
    return this.send("tasks/get", {}, signal ? { signal } : undefined);
  }

  cancel(opts?: { signal?: AbortSignal } | AbortSignal): Promise<Outcome<unknown>> {
    const signal = extractSignal(opts);
    return this.send("tasks/cancel", {}, { ...(signal ? { signal } : {}), notifyWatchers: true });
  }

  async update(
    inputResponses?: Obj,
    opts?: { signal?: AbortSignal } | AbortSignal,
  ): Promise<Outcome<unknown>> {
    const signal = extractSignal(opts);
    const denied = this.runtime.refusal("tasks/update");
    if (denied) return denied;
    if (signal?.aborted) {
      return { kind: "cancelled", wasSent: false, phase: "input", meta: meta("tasks/update") };
    }
    const requests = this.currentState()?.inputRequests;
    if (!inputResponses) {
      const elicOpts = this.runtime.opts.elicitation;
      if (!requests || !elicOpts) return violation("tasks/update", "missing task input");
      const responses: Obj = Object.create(null);
      const elicitSignal = signal ?? new AbortController().signal;
      for (const [key, req] of Object.entries(requests)) {
        if (req.method !== "elicitation/create") {
          return violation("tasks/update", "unsupported task input");
        }
        try {
          responses[key] = await elicit(req.params, elicOpts, elicitSignal);
        } catch {
          if (signal?.aborted) {
            return {
              kind: "cancelled",
              wasSent: false,
              phase: "input",
              meta: meta("tasks/update"),
            };
          }
          return violation("tasks/update", "elicitation failed");
        }
      }
      inputResponses = responses;
    }
    if (
      requests &&
      (Object.keys(requests).length !== Object.keys(inputResponses).length ||
        Object.keys(requests).some((k) => !Object.hasOwn(inputResponses!, k)))
    ) {
      return violation("tasks/update", "input keys differ");
    }
    return this.send(
      "tasks/update",
      { inputResponses },
      { ...(signal ? { signal } : {}), notifyWatchers: true },
    );
  }

  /**
   * Push-first watcher yielding task state updates. Uses `tasks/get` only initially
   * (when state is unknown), on wake-only notifications without state, or when `fallbackPoll` is enabled.
   */
  watch(opts: { signal?: AbortSignal; fallbackPoll?: boolean } = {}): AsyncIterable<TaskState> {
    const { signal, fallbackPoll = false } = opts;
    const queue = new NotificationQueue<TaskState | undefined>();
    let cleaned = false;
    const unsub = this.runtime.subscribe(this.id, (update) => {
      queue.push(update);
    });
    const onAbort = () => cleanup();
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      signal?.removeEventListener("abort", onAbort);
      unsub();
      queue.close();
    };
    if (signal) {
      if (signal.aborted) cleanup();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<TaskState> {
        try {
          if (signal?.aborted) return;
          let current = self.currentState();
          if (!current) {
            const out = await self.send("tasks/get", {}, signal ? { signal } : undefined);
            if (signal?.aborted) return;
            if (out.kind !== "ok") throw new McpOutcomeError(out);
            current = out.value as TaskState;
          }
          yield structuredClone(current);
          if (isTerminal(current.status)) return;

          const iter = queue[Symbol.asyncIterator]();
          let pendingNext: Promise<IteratorResult<TaskState | undefined>> | undefined;
          for (;;) {
            if (signal?.aborted) return;
            pendingNext ??= iter.next();
            let step: IteratorResult<TaskState | undefined> | "poll";
            if (fallbackPoll) {
              const interval =
                self.runtime.store.get(self.runtime.serverKey, self.id)?.pollIntervalMs ??
                current.pollIntervalMs ??
                1000;
              let clearPoll = () => {};
              const pollPromise = new Promise<"poll">((resolve) => {
                clearPoll = self.runtime.clock.setTimeout(() => resolve("poll"), interval);
              });
              step = await Promise.race([pendingNext, pollPromise]);
              clearPoll();
            } else {
              step = await pendingNext;
            }
            if (signal?.aborted) return;
            if (step === "poll") {
              const out = await self.send("tasks/get", {}, signal ? { signal } : undefined);
              if (signal?.aborted) return;
              if (out.kind !== "ok") throw new McpOutcomeError(out);
              current = out.value as TaskState;
              yield structuredClone(current);
              if (isTerminal(current.status)) return;
              continue;
            }
            pendingNext = undefined;
            if (step.done) return;
            if (step.value) {
              self.state = step.value;
              current = step.value;
              yield structuredClone(current);
              if (isTerminal(current.status)) return;
            } else {
              const out = await self.send("tasks/get", {}, signal ? { signal } : undefined);
              if (signal?.aborted) return;
              if (out.kind !== "ok") throw new McpOutcomeError(out);
              current = out.value as TaskState;
              yield structuredClone(current);
              if (isTerminal(current.status)) return;
            }
          }
        } finally {
          cleanup();
        }
      },
    };
  }
}

export class TasksExtension extends TasksRuntime implements Extension {
  readonly id = TASKS_ID;

  capabilities(isWorking: boolean): ExtensionCapabilities {
    return isWorking && this.opts.healthy !== false ? { extensions: { [this.id]: {} } } : {};
  }

  attach(host: ExtensionHost): Disposable {
    if (this.opts.healthy === false) return { dispose() {} };
    const resultReg = host.registerResultType("task", (r) => this.accept(r));
    let notifReg: Disposable | undefined;
    try {
      notifReg = host.onNotification?.("notifications/tasks", (n) => {
        this.notify(n);
      });
    } catch (err) {
      resultReg.dispose();
      throw err;
    }
    return {
      dispose() {
        notifReg?.dispose();
        resultReg.dispose();
      },
    };
  }
}

export function createTasksExtension(opts?: TasksOptions) {
  return new TasksExtension(opts);
}
