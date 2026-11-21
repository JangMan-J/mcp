import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { McpOutcomeError, type ConsentPort, type Outcome } from "@mcp-client/core";
import { TASKS_ID, TaskHandle, type TaskStatus } from "@mcp-client/ext-tasks";
import { DiskSkillCache, MemorySkillCache, SKILLS_EXTENSION_ID, SKILLS_PIN, SkillsClient } from "@mcp-client/ext-skills";
import type { DurableRuntime, ServerDescriptor } from "./runtime.js";

type Obj = Record<string, unknown>;

const ACTIVE_STATUSES = new Set(["working", "input_required"]);

export interface ExtendedFeaturesOptions {
  readonly consent?: ConsentPort;
  readonly deliver?: (event: Record<string, unknown>) => void | boolean | Promise<void | boolean>;
  readonly skillsCacheDir?: string;
}

export interface ExtendedFeaturesContext {
  readonly id: string;
  readonly runtime: DurableRuntime;
  readonly descriptor: ServerDescriptor;
  readonly db: DatabaseSync;
  readonly options?: ExtendedFeaturesOptions;
}

export interface ExtendedFeatures {
  names: string[];
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface PersistedTaskRow {
  readonly task_id: string;
  readonly status: string;
  readonly expires_at: number | null;
  readonly poll_interval_ms: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasExt(caps: Obj | undefined, id: string, revision?: string): boolean {
  const exts = caps?.extensions;
  if (!isObj(exts) || !Object.hasOwn(exts, id)) return false;
  const ext = exts[id];
  if (!isObj(ext)) return false;
  if (revision !== undefined && ext.revision !== undefined && ext.revision !== revision) return false;
  return true;
}

function isTaskState(v: unknown): v is Obj & { taskId: string; status: TaskStatus } {
  return isObj(v) && typeof v.taskId === "string" && typeof v.status === "string";
}

function reqString(args: Obj, field: string): string {
  const v = args[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return v;
}

function outcomeMessage(out: Exclude<Outcome<unknown>, { readonly kind: "ok" }>): string {
  if (out.kind === "jsonrpc-error") return `MCP jsonrpc-error(${out.code}): ${out.message}`;
  if (out.kind === "transport-failure") return `MCP transport-failure(${out.failure.kind}): ${out.failure.message}`;
  if (out.kind === "tool-isError") return `MCP tool error: ${JSON.stringify(out.result)}`;
  if ("detail" in out && out.detail !== undefined) {
    const detail = typeof out.detail === "string" ? out.detail : JSON.stringify(out.detail);
    return `MCP outcome(${out.kind}): ${detail}`;
  }
  return `MCP outcome: ${out.kind}`;
}

function throwOutcome(out: Exclude<Outcome<unknown>, { readonly kind: "ok" }>): never {
  const err = new McpOutcomeError(out);
  err.message = outcomeMessage(out);
  throw err;
}

export async function createExtendedFeatures(ctx: ExtendedFeaturesContext): Promise<ExtendedFeatures> {
  const { id: serverId, runtime: rt, descriptor, db, options } = ctx;
  const caps = rt.capabilities;
  const serverLabel = descriptor.name || serverId;
  const consent = options?.consent;
  const deliver = options?.deliver;

  const tasks = rt.tasks && !rt.tasks.refusal("task") ? rt.tasks : undefined;
  const skillsEnabled = isObj(caps?.resources) && hasExt(caps, SKILLS_EXTENSION_ID, SKILLS_PIN.date);

  const names: string[] = [];
  if (tasks) names.push("mcp_tasks");
  if (skillsEnabled) names.push("mcp_skills");

  const closeCtrl = new AbortController();
  const lifecycle = AbortSignal.any([rt.transportClosed, closeCtrl.signal]);

  let closed = false;

  const handles = new Map<string, TaskHandle>();
  const tracking = new Map<string, AbortController>();
  const loadSignal = new AsyncLocalStorage<AbortSignal>();

  async function approve(message: string): Promise<boolean> {
    if (!consent) return false;
    const signal = loadSignal.getStore() ?? lifecycle;
    signal.throwIfAborted();
    const res = await consent.request({ kind: "tool-call", serverLabel, message }, signal);
    return !signal.aborted && res.decision === "accept";
  }

  let skills: SkillsClient | undefined;
  if (skillsEnabled) {
    const cache = options?.skillsCacheDir
      ? new DiskSkillCache(join(options.skillsCacheDir, `server-${encodeURIComponent(serverId)}`))
      : new MemorySkillCache();
    skills = new SkillsClient({
      client: rt.client,
      capabilities: caps ?? {},
      serverKey: serverId,
      cache,
      approval: {
        approveLoad: req => approve(`Load skill ${req.skillUri} (${req.files.length} files, manifest ${req.manifestFingerprint})?`),
        approveTools: req => approve(`Allow skill ${req.skillUri} tools (${req.allowedTools.join(", ")})?`),
      },
    });
  }

  if (tasks) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS durable_task_handles (
        server_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER,
        poll_interval_ms INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, task_id)
      )
    `);
  }

  const nowMs = () => tasks?.clock.now() ?? Date.now();

  function getRow(taskId: string): PersistedTaskRow | undefined {
    return db.prepare(
      "SELECT task_id, status, expires_at, poll_interval_ms, created_at, updated_at FROM durable_task_handles WHERE server_id = ? AND task_id = ?",
    ).get(serverId, taskId) as PersistedTaskRow | undefined;
  }

  function isRowExpired(row: PersistedTaskRow | undefined): boolean {
    if (!row) return false;
    if (row.status === "expired") return true;
    return row.expires_at !== null && nowMs() >= row.expires_at;
  }

  function markExpired(taskId: string): void {
    db.prepare(
      "UPDATE durable_task_handles SET status = 'expired', updated_at = ? WHERE server_id = ? AND task_id = ?",
    ).run(nowMs(), serverId, taskId);
  }

  function stopTracking(taskId: string): void {
    tracking.get(taskId)?.abort();
    tracking.delete(taskId);
    handles.delete(taskId);
  }

  function assertNotExpired(taskId: string): void {
    const row = getRow(taskId);
    if (isRowExpired(row)) {
      if (row && row.status !== "expired") markExpired(taskId);
      stopTracking(taskId);
      throw new Error(`Task handle expired: ${taskId}`);
    }
  }

  function persistTask(taskId: string, status: string, state?: Obj): void {
    const now = nowMs();
    const existing = getRow(taskId);
    const rec = tasks?.store.get(tasks.serverKey, taskId);
    const createdAt = existing?.created_at ?? rec?.createdAt ?? now;
    let expiresAt: number | null = existing?.expires_at ?? null;
    if (state?.ttl === null) {
      expiresAt = null;
    } else {
      const ttl = typeof state?.ttlMs === "number" ? state.ttlMs
        : typeof state?.ttl === "number" ? state.ttl
        : existing === undefined ? rec?.ttlMs : undefined;
      if (typeof ttl === "number") expiresAt = createdAt + ttl;
    }
    const pollIntervalMs = typeof state?.pollIntervalMs === "number"
      ? state.pollIntervalMs
      : (rec?.pollIntervalMs ?? existing?.poll_interval_ms ?? null);

    db.prepare(`
      INSERT INTO durable_task_handles (server_id, task_id, status, expires_at, poll_interval_ms, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, task_id) DO UPDATE SET
        status = excluded.status,
        expires_at = excluded.expires_at,
        poll_interval_ms = excluded.poll_interval_ms,
        updated_at = excluded.updated_at
    `).run(serverId, taskId, status, expiresAt, pollIntervalMs, createdAt, now);
  }

  async function safeDeliver(event: Record<string, unknown>): Promise<void> {
    if (!deliver || lifecycle.aborted) return;
    try {
      await deliver(event);
    } catch {
      // Host delivery failure must not leave unhandled rejections in background polling.
    }
  }

  async function askInput(handle: TaskHandle, state: Obj, signal: AbortSignal): Promise<Outcome<unknown> | undefined> {
    if (!consent) return undefined;
    const requests = (state.inputRequests ?? {}) as Record<string, { method: string; params: Obj }>;
    const entries = Object.entries(requests);
    const valid = entries.length > 0 && entries.every(([, r]) =>
      r?.method === "elicitation/create" && (r.params?.mode === undefined || r.params.mode === "form"));
    if (!valid) return undefined;
    const responses: Obj = Object.create(null);
    for (const [key, req] of entries) {
      const res = await consent.request({
        kind: "form-elicitation",
        serverLabel,
        message: typeof req.params?.message === "string" ? req.params.message : `Task ${handle.id} needs input (${req.method})`,
        ...(isObj(req.params?.requestedSchema) ? { schema: req.params.requestedSchema } : {}),
      }, signal);
      if (signal.aborted) return undefined;
      responses[key] = res.decision === "accept" ? { action: "accept", content: res.content ?? {} } : { action: res.decision };
    }
    return handle.update(responses);
  }

  async function track(handle: TaskHandle, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([lifecycle, controller.signal]);
    let last: string | undefined = handle.status();
    let lastState: Obj | undefined;
    let asked: string | undefined;
    try {
      while (!signal.aborted) {
        if (last !== "working" && last !== "input_required") break;
        if (isRowExpired(getRow(handle.id))) {
          markExpired(handle.id);
          last = "expired";
          await safeDeliver({ kind: "task", serverId: ctx.id, taskId: handle.id, status: "expired" });
          return;
        }
        const out = await handle.get();
        // An in-flight get can finish after an explicit terminal action; do not overwrite it.
        if (signal.aborted) return;
        if (isRowExpired(getRow(handle.id))) continue;
        if (out.kind !== "ok" || !isTaskState(out.value)) {
          await safeDeliver({
            kind: "task",
            serverId: ctx.id,
            taskId: handle.id,
            status: "error",
            outcome: out.kind,
            error: out.kind === "ok" ? "Invalid task state" : outcomeMessage(out),
          });
          return;
        }
        lastState = out.value;
        persistTask(handle.id, out.value.status, out.value);
        let status = out.value.status;
        if (status === "input_required" && asked !== "input_required") {
          const upd = await askInput(handle, out.value, signal);
          if (signal.aborted) return;
          if (upd && upd.kind === "ok" && isTaskState(upd.value)) {
            lastState = upd.value;
            persistTask(handle.id, upd.value.status, upd.value);
            status = upd.value.status;
            asked = status;
          } else {
            asked = "input_required";
            await safeDeliver({
              kind: "task",
              serverId: ctx.id,
              taskId: handle.id,
              status: "input_required",
              ...(out.value.inputRequests !== undefined ? { inputRequests: out.value.inputRequests } : {}),
              ...(upd && upd.kind !== "ok" ? { error: outcomeMessage(upd) } : {}),
            });
          }
        } else {
          asked = status;
        }
        last = status;
      }
      if (!signal.aborted && last && !ACTIVE_STATUSES.has(last)) {
        stopTracking(handle.id);
        await safeDeliver({
          kind: "task",
          serverId: ctx.id,
          taskId: handle.id,
          status: last,
          ...(lastState?.result !== undefined ? { result: lastState.result } : {}),
          ...(lastState?.error !== undefined ? { error: lastState.error } : {}),
        });
      }
    } catch (err) {
      if (!signal.aborted) {
        await safeDeliver({
          kind: "task",
          serverId: ctx.id,
          taskId: handle.id,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (tracking.get(handle.id) === controller) {
        tracking.delete(handle.id);
        if (last && !ACTIVE_STATUSES.has(last)) handles.delete(handle.id);
      }
    }
  }

  function startTracking(handle: TaskHandle): void {
    handles.set(handle.id, handle);
    if (tracking.has(handle.id)) return;
    const controller = new AbortController();
    tracking.set(handle.id, controller);
    void track(handle, controller);
  }

  // Recover persisted active task handles for this server on startup.
  if (tasks && !lifecycle.aborted) {
    const rows = db.prepare(
      "SELECT task_id, status, expires_at, poll_interval_ms, created_at, updated_at FROM durable_task_handles WHERE server_id = ? AND status IN ('working', 'input_required')",
    ).all(serverId) as unknown as PersistedTaskRow[];
    for (const row of rows) {
      if (isRowExpired(row)) {
        markExpired(row.task_id);
        continue;
      }
      tasks.store.put({
        serverKey: tasks.serverKey,
        taskId: row.task_id,
        createdAt: row.created_at,
        lastStatus: row.status as TaskStatus,
        ...(row.expires_at !== null ? { ttlMs: Math.max(0, row.expires_at - row.created_at) } : {}),
        ...(row.poll_interval_ms !== null ? { pollIntervalMs: row.poll_interval_ms } : {}),
      });
      startTracking(tasks.resume(row.task_id));
    }
  }

  async function runTask(args: Obj, signal: AbortSignal): Promise<unknown> {
    if (!tasks) throw new Error(`Server ${serverId} does not support ${TASKS_ID}`);
    const action = reqString(args, "action");
    const callSignal = AbortSignal.any([lifecycle, signal]);

    switch (action) {
      case "call": {
        const tool = reqString(args, "tool");
        if (args.arguments !== undefined && !isObj(args.arguments)) {
          throw new TypeError("arguments must be an object");
        }
        const out = await rt.stateful.request(
          "tools/call",
          { name: tool, arguments: (args.arguments as Obj | undefined) ?? {} },
          { signal: callSignal },
        );
        callSignal.throwIfAborted();
        const accepted = out.kind === "ok" && isTaskState(out.value) ? tasks.accept(out.value) : out;
        if (accepted.kind === "ok") return accepted.value;
        if (accepted.kind !== "task-handle") throwOutcome(accepted);
        const handle = accepted.handle;
        if (!(handle instanceof TaskHandle)) throw new Error("Invalid task handle");
        const status = handle.status() ?? "working";
        persistTask(handle.id, status);
        if (ACTIVE_STATUSES.has(status)) startTracking(handle);
        return { taskId: handle.id, status };
      }
      case "get": {
        const taskId = reqString(args, "taskId");
        assertNotExpired(taskId);
        const handle = handles.get(taskId) ?? tasks.resume(taskId);
        const out = await handle.get();
        callSignal.throwIfAborted();
        assertNotExpired(taskId);
        if (out.kind !== "ok") throwOutcome(out);
        if (isTaskState(out.value)) {
          persistTask(taskId, out.value.status, out.value);
          if (ACTIVE_STATUSES.has(out.value.status)) startTracking(handle);
          else stopTracking(taskId);
        }
        return out.value;
      }
      case "update": {
        const taskId = reqString(args, "taskId");
        assertNotExpired(taskId);
        if (args.inputResponses !== undefined && !isObj(args.inputResponses)) {
          throw new TypeError("inputResponses must be an object");
        }
        const handle = handles.get(taskId) ?? tasks.resume(taskId);
        const out = await handle.update(args.inputResponses as Obj | undefined);
        callSignal.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        if (isTaskState(out.value)) {
          persistTask(taskId, out.value.status, out.value);
          if (ACTIVE_STATUSES.has(out.value.status)) startTracking(handle);
          else stopTracking(taskId);
        }
        return out.value;
      }
      case "cancel": {
        const taskId = reqString(args, "taskId");
        assertNotExpired(taskId);
        const handle = handles.get(taskId) ?? tasks.resume(taskId);
        const out = await handle.cancel();
        lifecycle.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        if (isTaskState(out.value)) {
          persistTask(taskId, out.value.status, out.value);
          if (!ACTIVE_STATUSES.has(out.value.status)) stopTracking(taskId);
        }
        callSignal.throwIfAborted();
        return out.value;
      }
      case "active": {
        for (const id of [...handles.keys()]) {
          if (isRowExpired(getRow(id))) {
            markExpired(id);
            stopTracking(id);
          }
        }
        return {
          tasks: [...handles.values()].map(h => ({ taskId: h.id, status: h.status() })),
        };
      }
      default:
        throw new Error(`Unknown mcp_tasks action: ${action}`);
    }
  }

  async function runSkill(args: Obj, signal: AbortSignal): Promise<unknown> {
    if (!skills) throw new Error(`Server ${serverId} does not support ${SKILLS_EXTENSION_ID}`);
    const action = reqString(args, "action");

    switch (action) {
      case "list": {
        const out = await skills.listAll();
        signal.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        return out.value;
      }
      case "get": {
        const skillUri = reqString(args, "skillUri");
        const out = await skills.get(skillUri);
        signal.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        return out.value;
      }
      case "load": {
        const skillUri = reqString(args, "skillUri");
        const got = await skills.get(skillUri);
        signal.throwIfAborted();
        if (got.kind !== "ok") throwOutcome(got);
        const approved = await loadSignal.run(signal, () => skills.approve(skillUri));
        signal.throwIfAborted();
        if (!approved) throw new Error(`Skill load denied: ${skillUri}`);
        return { skillUri, approved: true };
      }
      case "read_file": {
        const skillUri = reqString(args, "skillUri");
        const fileUri = reqString(args, "fileUri");
        const out = await skills.readFile(skillUri, fileUri);
        signal.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        return { uri: out.value.file.uri, fromCache: out.value.fromCache, text: out.value.text };
      }
      case "directory": {
        const skillUri = reqString(args, "skillUri");
        const dirUri = typeof args.dirUri === "string" && args.dirUri.length > 0 ? args.dirUri : skillUri;
        const out = await skills.readDirectory(skillUri, dirUri);
        signal.throwIfAborted();
        if (out.kind !== "ok") throwOutcome(out);
        return out.value;
      }
      default:
        throw new Error(`Unknown mcp_skills action: ${action}`);
    }
  }

  return {
    names,
    async run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
      if (closed) throw new Error("Extended features closed");
      signal.throwIfAborted();
      if (lifecycle.aborted) throw new Error("Runtime transport closed");
      if (!isObj(args)) throw new TypeError("args must be an object");
      if (name === "mcp_tasks") return runTask(args, signal);
      if (name === "mcp_skills") return runSkill(args, AbortSignal.any([lifecycle, signal]));
      throw new Error(`Unknown extended feature tool: ${name}`);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeCtrl.abort();
      handles.clear();
      tracking.clear();
    },
  };
}
