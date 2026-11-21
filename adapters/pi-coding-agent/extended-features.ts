import { join } from "node:path";
import type { ConsentPort, Outcome } from "@mcp-client/core";
import { TasksRuntime, type TaskHandle } from "@mcp-client/ext-tasks";
import { DiskSkillCache, SkillsClient } from "@mcp-client/ext-skills";
import { canonicalServerCardUrl, discoverCard } from "@mcp-client/ext-server-cards";
import { createAppsExtension, type AppRenderPort } from "@mcp-client/ext-apps";
import type { LegacyServerConfig } from "./config.js";
import type { LiveMcpServerRuntime } from "./pi-extension.js";

export interface ExtendedFeaturesHost {
  registerTool(def: Record<string, unknown>): void;
  wake(server: string, reason: string): void;
  readonly consent?: ConsentPort;
  readonly configDir: string;
  readonly appRenderer?: AppRenderPort;
}

type Obj = Record<string, unknown>;
const MAX_TEXT = 16_000;
const TASKS_ID = "io.modelcontextprotocol/tasks";
const SKILLS_ID = "io.modelcontextprotocol/skills";

/** Shared Pi tool schemas (also used by the live check fixture). */
export const TASK_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["call", "get", "update", "cancel", "active"] },
    server: { type: "string" },
    tool: { type: "string" },
    arguments: { type: "object" },
    taskId: { type: "string" },
    inputResponses: { type: "object" },
  },
  required: ["action"],
} as const;

export const SKILL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["list", "get", "load", "read_file", "directory"] },
    server: { type: "string" },
    skillUri: { type: "string" },
    fileUri: { type: "string" },
    dirUri: { type: "string" },
  },
  required: ["action"],
} as const;

/** Bounded text + structured result in Pi's tool-result shape. */
export function boundedResult(value: unknown, isError = false) {
  const json = JSON.stringify(value ?? null, null, 2) ?? "null";
  const text = json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}\n…[truncated ${json.length - MAX_TEXT} chars]` : json;
  const structured = typeof value === "object" && value !== null && json.length <= MAX_TEXT ? value : undefined;
  return { content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}), details: { isError } };
}

function fromOutcome(out: Outcome<unknown>) {
  return out.kind === "ok" ? boundedResult(out.value) : boundedResult(out, true);
}

function hasExt(caps: Obj | undefined, id: string): boolean {
  const exts = caps?.extensions;
  return typeof exts === "object" && exts !== null && Object.hasOwn(exts, id);
}

const isTaskState = (v: unknown): v is { taskId: string; status: string } =>
  typeof v === "object" && v !== null && typeof (v as Obj).taskId === "string" && typeof (v as Obj).status === "string";

interface ServerEntry {
  readonly rt: LiveMcpServerRuntime;
  readonly tasks?: TasksRuntime;
  readonly skills?: SkillsClient;
  readonly handles: Map<string, TaskHandle>;
  dispose?(): void;
}

export function createExtendedFeatures(host: ExtendedFeaturesHost) {
  const servers = new Map<string, ServerEntry>();
  let tasksTool = false;
  let skillsTool = false;

  const pick = (server: unknown): [string, ServerEntry] | undefined => {
    if (typeof server === "string") { const e = servers.get(server); return e ? [server, e] : undefined; }
    if (servers.size === 1) return [...servers][0];
    return undefined;
  };

  async function askInput(server: string, handle: TaskHandle, state: Obj, signal: AbortSignal): Promise<Outcome<unknown> | undefined> {
    if (!host.consent) return undefined;
    const requests = (state.inputRequests ?? {}) as Record<string, { method: string; params: Obj }>;
    const responses: Obj = {};
    // Fail closed: only form elicitation can be answered through consent; anything else is left to the model.
    const valid = Object.values(requests).every(r => r?.method === "elicitation/create" && (r.params?.mode === undefined || r.params.mode === "form"));
    if (!valid || Object.keys(requests).length === 0) return undefined;
    for (const [key, req] of Object.entries(requests)) {
      const res = await host.consent.request({
        kind: "form-elicitation",
        serverLabel: server,
        message: typeof req.params?.message === "string" ? req.params.message : `Task ${handle.id} needs input (${req.method})`,
        ...(typeof req.params?.requestedSchema === "object" ? { schema: req.params.requestedSchema as Obj } : {}),
      }, signal);
      responses[key] = res.decision === "accept" ? { action: "accept", content: res.content ?? {} } : { action: res.decision };
    }
    return handle.update(responses);
  }

  /** Background tracker: polls tasks/get, routes input_required through consent, wakes Pi on terminal state. */
  async function track(server: string, entry: ServerEntry, handle: TaskHandle, signal: AbortSignal) {
    let last: string | undefined = handle.status();
    // Initial input_required is handled like a transition (asked once before polling).
    let asked: string | undefined = "working";
    try {
      while (!signal.aborted && !entry.rt.transportClosed.aborted) {
        if (last !== "working" && last !== "input_required") break;
        const out = await handle.get();
        if (out.kind !== "ok" || !isTaskState(out.value)) { host.wake(server, `task ${handle.id} poll failed: ${out.kind}`); return; }
        const status = out.value.status;
        if (status === "input_required" && asked !== "input_required") {
          const upd = await askInput(server, handle, out.value as Obj, signal);
          if (!upd) host.wake(server, `task ${handle.id} input_required`);
        }
        asked = status;
        last = handle.status() ?? status;
      }
      if (last && last !== "working" && last !== "input_required") host.wake(server, `task ${handle.id} ${last}`);
    } catch (err) {
      if (!signal.aborted) host.wake(server, `task ${handle.id} error: ${String(err)}`);
    } finally {
      if (last !== "working" && last !== "input_required") entry.handles.delete(handle.id);
    }
  }

  async function runTask(p: Obj, signal: AbortSignal) {
    const found = pick(p.server);
    if (!found) return boundedResult({ error: "unknown or ambiguous server", servers: [...servers.keys()] }, true);
    const [server, entry] = found;
    if (!entry.tasks) return boundedResult({ error: `server ${server} does not support ${TASKS_ID}` }, true);
    const tasks = entry.tasks;
    const handleFor = (id: unknown) => typeof id === "string" ? entry.handles.get(id) ?? tasks.resume(id) : undefined;
    switch (p.action) {
      case "call": {
        if (typeof p.tool !== "string") return boundedResult({ error: "tool required" }, true);
        const out = await entry.rt.stateful.request("tools/call", { name: p.tool, arguments: (p.arguments ?? {}) as Obj }, { signal }) as Outcome<unknown>;
        const accepted = out.kind === "ok" && isTaskState(out.value) ? tasks.accept(out.value as Obj) : out;
        if (accepted.kind !== "task-handle") return fromOutcome(accepted);
        const handle = (accepted as { handle: TaskHandle }).handle;
        entry.handles.set(handle.id, handle);
        void track(server, entry, handle, entry.rt.transportClosed);
        return boundedResult({ taskId: handle.id, status: handle.status() });
      }
      case "get": case "update": case "cancel": {
        const h = handleFor(p.taskId);
        if (!h) return boundedResult({ error: "taskId required" }, true);
        if (p.action === "cancel") return fromOutcome(await h.cancel());
        if (p.action === "update") return fromOutcome(await h.update(p.inputResponses as Obj | undefined));
        return fromOutcome(await h.get());
      }
      case "active":
        return boundedResult({ tasks: [...entry.handles.values()].map(h => ({ taskId: h.id, status: h.status() })) });
      default:
        return boundedResult({ error: `unknown action ${String(p.action)}` }, true);
    }
  }

  async function runSkill(p: Obj) {
    const found = pick(p.server);
    if (!found) return boundedResult({ error: "unknown or ambiguous server", servers: [...servers.keys()] }, true);
    const [server, entry] = found;
    const skills = entry.skills;
    if (!skills) return boundedResult({ error: `server ${server} does not support ${SKILLS_ID}` }, true);
    const uri = typeof p.skillUri === "string" ? p.skillUri : undefined;
    switch (p.action) {
      case "list": return fromOutcome(await skills.listAll());
      case "get": return uri ? fromOutcome(await skills.get(uri)) : boundedResult({ error: "skillUri required" }, true);
      case "load": {
        if (!uri) return boundedResult({ error: "skillUri required" }, true);
        const got = await skills.get(uri);
        if (got.kind !== "ok") return fromOutcome(got);
        const approved = await skills.approve(uri);
        return boundedResult({ skillUri: uri, approved }, !approved);
      }
      case "read_file": {
        if (!uri || typeof p.fileUri !== "string") return boundedResult({ error: "skillUri and fileUri required" }, true);
        const out = await skills.readFile(uri, p.fileUri);
        if (out.kind !== "ok") return fromOutcome(out);
        return boundedResult({ uri: out.value.file.uri, fromCache: out.value.fromCache, text: out.value.text });
      }
      case "directory": {
        if (!uri) return boundedResult({ error: "skillUri required" }, true);
        return fromOutcome(await skills.readDirectory(uri, typeof p.dirUri === "string" ? p.dirUri : uri));
      }
      default:
        return boundedResult({ error: `unknown action ${String(p.action)}` }, true);
    }
  }

  function ensureTools() {
    const any = (key: "tasks" | "skills") => [...servers.values()].some(e => e[key]);
    if (!tasksTool && any("tasks")) {
      tasksTool = true;
      host.registerTool({
        name: "mcp_tasks",
        description: "Run and manage long-running MCP tasks: call a tool as a task, get/update/cancel by taskId, or list active tasks.",
        parameters: TASK_TOOL_SCHEMA,
        execute: (_id: string, params: Obj, signal: AbortSignal) => runTask(params ?? {}, signal),
      });
    }
    if (!skillsTool && any("skills")) {
      skillsTool = true;
      host.registerTool({
        name: "mcp_skills",
        description: "Discover and load MCP server skills: list, get, load (requires approval), read_file, directory.",
        parameters: SKILL_TOOL_SCHEMA,
        execute: (_id: string, params: Obj) => runSkill(params ?? {}),
      });
    }
  }

  return {
    connect(rt: LiveMcpServerRuntime, descriptor: LegacyServerConfig, signal: AbortSignal): void {
      const server = descriptor.name;
      const caps = rt.capabilities as Obj | undefined;
      const consent = host.consent;
      const prev = servers.get(server);
      const entry: ServerEntry = {
        rt,
        // Reconnect (e.g. after sign-in) keeps tracked task handles and replaces the rest.
        handles: prev?.handles ?? new Map(),
        ...(hasExt(caps, TASKS_ID) ? {
          // Reuse the client-attached extension so result-type tracking shares one store; fakes fall back.
          tasks: rt.tasks ?? new TasksRuntime({
            serverKey: server,
            peerCapabilities: () => (rt.capabilities ?? {}) as Obj,
            request: (method, params, options) => rt.stateful.request(method, params, options) as PromiseLike<Outcome<unknown>>,
          }),
        } : {}),
        ...(hasExt(caps, SKILLS_ID) ? {
          skills: new SkillsClient({
            client: rt.client,
            capabilities: caps ?? {},
            serverKey: server,
            // Confined per-server cache under the adapter config dir.
            cache: new DiskSkillCache(join(host.configDir, "skills-cache", encodeURIComponent(server))),
            approval: {
              // Verified manifest (fingerprint + files) is shown before any load; no consent port means deny.
              approveLoad: async req => consent ? (await consent.request({
                kind: "tool-call",
                serverLabel: server,
                message: `Load skill ${req.skillUri} (${req.files.length} files, manifest ${req.manifestFingerprint})?`,
              }, signal)).decision === "accept" : false,
            },
          }),
        } : {}),
      };
      prev?.dispose?.();
      const disposeApps = host.appRenderer ? rt.client.use(createAppsExtension({ renderer: host.appRenderer })) : undefined;
      servers.set(server, entry);
      ensureTools();
      const cleanup = () => {
        if (servers.get(server) === entry) servers.delete(server);
        entry.handles.clear();
        disposeApps?.dispose();
      };
      entry.dispose = () => disposeApps?.dispose();
      if (rt.transportClosed.aborted || signal.aborted) cleanup();
      else {
        rt.transportClosed.addEventListener("abort", cleanup, { once: true });
        signal.addEventListener("abort", cleanup, { once: true });
      }
    },
    inspectServerCard,
    /** Visible for tests. */
    servers: servers as ReadonlyMap<string, ServerEntry>,
  };
}

/** Advisory only: card metadata never becomes capability. Returns undefined when unavailable. */
export async function inspectServerCard(descriptor: LegacyServerConfig, signal: AbortSignal): Promise<unknown> {
  if (descriptor.transport !== "http" || !descriptor.url || signal.aborted) return undefined;
  const aborted = new Promise<undefined>(resolve => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
  try {
    const parsed = await Promise.race([discoverCard(canonicalServerCardUrl(descriptor.url)), aborted]);
    return parsed ? { advisory: true, url: parsed.url, card: parsed.card, ignoredFields: parsed.ignoredFields } : undefined;
  } catch {
    return undefined;
  }
}
