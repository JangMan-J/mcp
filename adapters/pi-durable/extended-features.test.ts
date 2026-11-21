import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConsentPort, Outcome } from "@mcp-client/core";
import { createTasksExtension } from "@mcp-client/ext-tasks";
import { createExtendedFeatures } from "./extended-features.js";
import { openRuntime, type DurableRuntime, type ServerDescriptor } from "./runtime.js";

// The .mjs fixture is untyped; a non-literal specifier plus a narrow interface avoids TS7016 without suppression.
interface LiveFixture {
  startFixture(): Promise<{ base: string; mcpUrl: string; close(): Promise<void> }>;
  SKILL: string;
  SKILL_FILE: string;
  TASK: string;
}
const FIXTURE_PATH = "../../scripts/pi-trial/live-ext-fixture.mjs";
const loadFixture = () => import(FIXTURE_PATH) as Promise<LiveFixture>;

type Obj = Record<string, unknown>;

const meta = (method: string) => ({ requestId: 1, method, binding: "local", attempts: 1 });
const ok = (method: string, value: unknown): Outcome<unknown> => ({ kind: "ok", value, meta: meta(method) });
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function fakeRuntime(caps: Obj | undefined, script: Record<string, unknown[]>) {
  const closed = new AbortController();
  const calls: Array<{ method: string; params: unknown }> = [];
  const nextFor = (method: string, params: unknown): Outcome<unknown> => {
    calls.push({ method, params });
    const taskId = (params as Obj | undefined)?.taskId;
    const next = (script[`${method}:${taskId}`] ?? script[method])?.shift();
    return next === undefined
      ? { kind: "jsonrpc-error", code: -32601, message: `unscripted ${method}`, meta: meta(method) }
      : ok(method, next);
  };
  const statefulRequest = vi.fn((method: string, params: unknown) => Promise.resolve(nextFor(method, params)));
  const clientRequest = vi.fn((method: string, params: unknown) => Promise.resolve(nextFor(method, params)));
  const tasks = createTasksExtension({
    serverKey: "srv",
    peerCapabilities: () => caps ?? {},
    request: (method, params) => statefulRequest(method, params),
  });
  const rt = {
    capabilities: caps,
    transportClosed: closed.signal,
    stateful: { request: statefulRequest },
    client: { server: { key: "srv" }, request: clientRequest, use: vi.fn(() => ({ dispose: vi.fn() })) },
    tasks,
    eventsExtension: {},
    openEventsStream: vi.fn(),
    ops: {},
    ready: vi.fn(),
    rediscover: vi.fn(),
    close: vi.fn(async () => { closed.abort(); }),
  } as unknown as DurableRuntime;
  return { rt, closed, calls };
}

const descriptor = (name = "srv"): ServerDescriptor => ({ name } as unknown as ServerDescriptor);
const TASKS_CAP = { extensions: { "io.modelcontextprotocol/tasks": {} } };
const SKILLS_CAP = { resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } };
const BOTH_CAPS = { resources: {}, extensions: { "io.modelcontextprotocol/tasks": {}, "io.modelcontextprotocol/skills": {} } };

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (dbs.length) {
    const db = dbs.pop()!;
    if (db.isOpen) db.close();
  }
  while (dirs.length) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

function openDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  return db;
}

describe("pi-durable extended features", () => {
  it("gates names on negotiated capabilities and rejects disabled tools", async () => {
    const none = await createExtendedFeatures({
      id: "s0", runtime: fakeRuntime({}, {}).rt, descriptor: descriptor("s0"), db: openDb(),
    });
    expect(none.names).toEqual([]);
    await expect(none.run("mcp_tasks", { action: "active" }, new AbortController().signal)).rejects.toThrow(/does not support/);
    await expect(none.run("mcp_skills", { action: "list" }, new AbortController().signal)).rejects.toThrow(/does not support/);
    await none.close();

    const badRev = await createExtendedFeatures({
      id: "s-bad",
      runtime: fakeRuntime({
        resources: {},
        extensions: { "io.modelcontextprotocol/tasks": { revision: "1999-01-01" }, "io.modelcontextprotocol/skills": { revision: "1999-01-01" } },
      }, {}).rt,
      descriptor: descriptor("s-bad"),
      db: openDb(),
    });
    expect(badRev.names).toEqual([]);
    await badRev.close();

    const tasksOnly = await createExtendedFeatures({
      id: "s1", runtime: fakeRuntime(TASKS_CAP, {}).rt, descriptor: descriptor("s1"), db: openDb(),
    });
    expect(tasksOnly.names).toEqual(["mcp_tasks"]);
    await tasksOnly.close();

    const skillsOnly = await createExtendedFeatures({
      id: "s2", runtime: fakeRuntime(SKILLS_CAP, {}).rt, descriptor: descriptor("s2"), db: openDb(),
    });
    expect(skillsOnly.names).toEqual(["mcp_skills"]);
    await skillsOnly.close();

    const both = await createExtendedFeatures({
      id: "s3", runtime: fakeRuntime(BOTH_CAPS, {}).rt, descriptor: descriptor("s3"), db: openDb(),
    });
    expect(both.names).toEqual(["mcp_tasks", "mcp_skills"]);
    await both.close();
  });

  it("runs mcp_tasks call/get/update/cancel/active, persists before deliver, and handles consent", async () => {
    const db = openDb();
    let statusAtDeliver: string | undefined;
    const deliver = vi.fn((event: Record<string, unknown>) => {
      const row = db.prepare("SELECT status FROM durable_task_handles WHERE server_id = ? AND task_id = ?")
        .get("srv", String(event.taskId)) as { status: string } | undefined;
      statusAtDeliver = row?.status;
    });
    const consent: ConsentPort = {
      request: vi.fn(async () => ({ decision: "accept" as const, content: { ok: true } })),
    };
    const { rt, calls } = fakeRuntime(TASKS_CAP, {
      "tools/call": [
        { taskId: "t1", status: "working", pollIntervalMs: 1 },
        { content: [{ type: "text", text: "fast-result" }] },
        { taskId: "t2", status: "working", pollIntervalMs: 1 },
      ],
      "tasks/get:t1": [
        { taskId: "t1", status: "input_required", pollIntervalMs: 1, inputRequests: { q: { method: "elicitation/create", params: { message: "Approve?" } } } },
      ],
      "tasks/get:t3": [{ taskId: "t3", status: "working" }],
      "tasks/update": [
        { taskId: "t1", status: "completed", result: { content: [{ type: "text", text: "done" }] } },
        { taskId: "t3", status: "working" },
      ],
      "tasks/cancel": [{ taskId: "t2", status: "cancelled" }],
    });

    const features = await createExtendedFeatures({
      id: "srv", runtime: rt, descriptor: descriptor("srv"), db, options: { consent, deliver },
    });
    const sig = new AbortController().signal;

    // 1. Task call with input_required -> consent -> tasks/update -> completed -> deliver after persistence
    const callRes = await features.run("mcp_tasks", { action: "call", tool: "slow", arguments: { x: 1 } }, sig);
    expect(callRes).toEqual({ taskId: "t1", status: "working" });
    expect(calls[0]).toEqual({ method: "tools/call", params: { name: "slow", arguments: { x: 1 } } });

    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task",
      serverId: "srv",
      taskId: "t1",
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    })));
    expect(statusAtDeliver).toBe("completed");
    expect(consent.request).toHaveBeenCalledWith(expect.objectContaining({ kind: "form-elicitation", message: "Approve?" }), expect.anything());
    expect(await features.run("mcp_tasks", { action: "active" }, sig)).toEqual({ tasks: [] });

    // 2. Non-task tool call returns raw value
    expect(await features.run("mcp_tasks", { action: "call", tool: "fast" }, sig)).toEqual({
      content: [{ type: "text", text: "fast-result" }],
    });

    // 3. Cancel active task
    await features.run("mcp_tasks", { action: "call", tool: "slow2" }, sig);
    expect(await features.run("mcp_tasks", { action: "active" }, sig)).toEqual({
      tasks: [{ taskId: "t2", status: "working" }],
    });
    expect(await features.run("mcp_tasks", { action: "cancel", taskId: "t2" }, sig)).toEqual({
      taskId: "t2", status: "cancelled",
    });
    expect(await features.run("mcp_tasks", { action: "active" }, sig)).toEqual({ tasks: [] });

    // 4. Direct get and update
    expect(await features.run("mcp_tasks", { action: "get", taskId: "t3" }, sig)).toEqual({ taskId: "t3", status: "working" });
    expect(await features.run("mcp_tasks", { action: "update", taskId: "t3", inputResponses: { a: { action: "accept" } } }, sig)).toEqual({
      taskId: "t3", status: "working",
    });

    // 5. Validation errors throw
    await expect(features.run("mcp_tasks", { action: "call" }, sig)).rejects.toThrow(/tool/);
    await expect(features.run("mcp_tasks", { action: "get" }, sig)).rejects.toThrow(/taskId/);
    await expect(features.run("mcp_tasks", { action: "bogus" }, sig)).rejects.toThrow(/Unknown mcp_tasks action/);

    await features.close();
    await expect(features.run("mcp_tasks", { action: "active" }, sig)).rejects.toThrow(/closed/);
  });

  it("does not submit pending consent after explicit cancellation", async () => {
    const db = openDb();
    const { rt, calls } = fakeRuntime(TASKS_CAP, {
      "tools/call": [{ taskId: "t-cancel", status: "working", pollIntervalMs: 1 }],
      "tasks/get": [{ taskId: "t-cancel", status: "input_required", inputRequests: {
        answer: { method: "elicitation/create", params: { message: "Approve?" } },
      } }],
      "tasks/cancel": [{ taskId: "t-cancel", status: "cancelled" }],
    });
    let approve!: (result: Awaited<ReturnType<ConsentPort["request"]>>) => void;
    const approval = new Promise<Awaited<ReturnType<ConsentPort["request"]>>>(resolve => { approve = resolve; });
    let consentSignal: AbortSignal | undefined;
    const features = await createExtendedFeatures({
      id: "srv", runtime: rt, descriptor: descriptor(), db,
      options: { consent: { request: (_, signal) => { consentSignal = signal; return approval; } } },
    });
    try {
      const signal = new AbortController().signal;
      await features.run("mcp_tasks", { action: "call", tool: "ask" }, signal);
      await vi.waitFor(() => expect(consentSignal).toBeDefined());
      await features.run("mcp_tasks", { action: "cancel", taskId: "t-cancel" }, signal);
      expect(consentSignal?.aborted).toBe(true);
      approve({ decision: "accept", content: { value: "too late" } });
      await new Promise(resolve => setImmediate(resolve));
      expect(calls.map(c => c.method)).toEqual(["tools/call", "tasks/get", "tasks/cancel"]);
      expect(db.prepare("SELECT status FROM durable_task_handles").get()).toMatchObject({ status: "cancelled" });
    } finally {
      await features.close();
    }
  });

  it("delivers input_required when no consent port is provided", async () => {
    const db = openDb();
    const deliver = vi.fn();
    const { rt } = fakeRuntime(TASKS_CAP, {
      "tools/call": [{ taskId: "t-noconsent", status: "working", pollIntervalMs: 1 }],
      "tasks/get": [
        { taskId: "t-noconsent", status: "input_required", pollIntervalMs: 1, inputRequests: { k: { method: "elicitation/create", params: { message: "Need input" } } } },
        { taskId: "t-noconsent", status: "completed" },
      ],
    });
    const features = await createExtendedFeatures({
      id: "srv", runtime: rt, descriptor: descriptor("srv"), db, options: { deliver },
    });
    await features.run("mcp_tasks", { action: "call", tool: "ask" }, new AbortController().signal);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task", serverId: "srv", taskId: "t-noconsent", status: "input_required",
    })));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      kind: "task", serverId: "srv", taskId: "t-noconsent", status: "completed",
    })));
    await features.close();
  });

  it("recovers persisted active task handles on restart and refuses expired handles without sending", async () => {
    const db = openDb();
    const now = Date.now();

    // Seed DB directly as if a prior host crashed while t-live was working and t-old expired.
    db.exec(`
      CREATE TABLE durable_task_handles (
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
    db.prepare("INSERT INTO durable_task_handles VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "srv", "t-live", "working", now + 60_000, null, now - 1000, now - 1000,
    );
    db.prepare("INSERT INTO durable_task_handles VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "srv", "t-old", "working", now - 1, 1, now - 5000, now - 5000,
    );

    const deliver = vi.fn();
    const { rt, calls } = fakeRuntime(TASKS_CAP, {
      "tasks/get": [{ taskId: "t-live", status: "completed", result: { ok: true } }],
    });
    const features = await createExtendedFeatures({
      id: "srv", runtime: rt, descriptor: descriptor("srv"), db, options: { deliver },
    });
    const sig = new AbortController().signal;

    // Immediately visible in active before background recovery poll completes; expired handle is excluded.
    expect(await features.run("mcp_tasks", { action: "active" }, sig)).toEqual({
      tasks: [{ taskId: "t-live", status: "working" }],
    });

    // Expired handle refuses explicit get/cancel without sending.
    await expect(features.run("mcp_tasks", { action: "get", taskId: "t-old" }, sig)).rejects.toThrow(/expired/);
    await expect(features.run("mcp_tasks", { action: "cancel", taskId: "t-old" }, sig)).rejects.toThrow(/expired/);

    // Recovered live handle polls tasks/get and delivers completion after persistence.
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith({
      kind: "task",
      serverId: "srv",
      taskId: "t-live",
      status: "completed",
      result: { ok: true },
    }), { timeout: 2000 });
    expect(calls.filter(c => c.method === "tasks/get").map(c => c.params)).toEqual([{ taskId: "t-live" }]);

    const expiredRow = db.prepare("SELECT status FROM durable_task_handles WHERE task_id = 't-old'").get() as { status: string };
    expect(expiredRow.status).toBe("expired");
    await features.close();
  });

  it("persists DurableHandles snapshots in the task row, reopens them, and close sends nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-durable-ext-"));
    dirs.push(dir);
    const file = join(dir, "t.db");
    const db1 = new DatabaseSync(file);
    dbs.push(db1);
    const first = fakeRuntime(TASKS_CAP, {
      "tools/call": [
        { taskId: "t-keep", status: "working", pollIntervalMs: 60_000 },
        { taskId: "t-exp", status: "working", pollIntervalMs: 60_000, ttlMs: 1 },
      ],
      "tasks/get": [{ taskId: "t-keep", status: "working", pollIntervalMs: 60_000 }],
    });
    const f1 = await createExtendedFeatures({ id: "srv", runtime: first.rt, descriptor: descriptor(), db: db1 });
    const sig = new AbortController().signal;
    await f1.run("mcp_tasks", { action: "call", tool: "a" }, sig);
    await f1.run("mcp_tasks", { action: "call", tool: "b" }, sig);
    const snap = (id: string) => JSON.parse((db1.prepare("SELECT handle_json FROM durable_task_handles WHERE task_id = ?")
      .get(id) as { handle_json: string }).handle_json);
    expect(snap("t-keep")).toEqual({ kind: "task", taskId: "t-keep" });
    expect(snap("t-exp")).toMatchObject({ kind: "task", taskId: "t-exp", expiresAt: expect.any(Number) });
    const callsBeforeClose = first.calls.length;
    await f1.close();
    expect(first.calls.length).toBe(callsBeforeClose); // close sends nothing (no tasks/cancel)
    expect(first.calls.some(c => c.method === "tasks/cancel")).toBe(false);
    expect(db1.prepare("SELECT status FROM durable_task_handles WHERE task_id = 't-keep'").get()).toMatchObject({ status: "working" });
    db1.close();

    // Reopen: live task is recovered from snapshot-backed row; expired one is not polled.
    await new Promise(r => setTimeout(r, 5));
    const db2 = new DatabaseSync(file);
    dbs.push(db2);
    const second = fakeRuntime(TASKS_CAP, {});
    const f2 = await createExtendedFeatures({ id: "srv", runtime: second.rt, descriptor: descriptor(), db: db2 });
    expect(await f2.run("mcp_tasks", { action: "active" }, sig)).toEqual({ tasks: [{ taskId: "t-keep", status: "working" }] });
    await expect(f2.run("mcp_tasks", { action: "get", taskId: "t-exp" }, sig)).rejects.toThrow(/expired/);
    expect(db2.prepare("SELECT status FROM durable_task_handles WHERE task_id = 't-exp'").get()).toMatchObject({ status: "expired" });
    expect(second.calls.some(c => (c.params as Obj | undefined)?.taskId === "t-exp")).toBe(false);
    await f2.close();
    expect(second.calls.some(c => c.method === "tasks/cancel")).toBe(false);
  });

  it("expires a recovered task from its DurableHandles snapshot", async () => {
    const db = openDb();
    const now = Date.now();
    const seed = fakeRuntime(TASKS_CAP, { "tools/call": [{ taskId: "t-snap", status: "working", pollIntervalMs: 60_000 }] });
    const f0 = await createExtendedFeatures({ id: "srv", runtime: seed.rt, descriptor: descriptor(), db });
    await f0.run("mcp_tasks", { action: "call", tool: "a" }, new AbortController().signal);
    await f0.close();
    db.prepare("UPDATE durable_task_handles SET handle_json = ?").run(JSON.stringify({ kind: "task", taskId: "t-snap", expiresAt: now - 1 }));
    const next = fakeRuntime(TASKS_CAP, {});
    const f1 = await createExtendedFeatures({ id: "srv", runtime: next.rt, descriptor: descriptor(), db });
    expect(await f1.run("mcp_tasks", { action: "active" }, new AbortController().signal)).toEqual({ tasks: [] });
    expect(db.prepare("SELECT status FROM durable_task_handles").get()).toMatchObject({ status: "expired" });
    expect(next.calls).toEqual([]);
    await f1.close();
  });

  it("cancels a created remote task on user abort but not on shutdown", async () => {
    const user = new AbortController();
    const dbU = openDb();
    const a = fakeRuntime(TASKS_CAP, {
      "tools/call": [{ taskId: "t-abort", status: "working" }],
      "tasks/cancel": [{ taskId: "t-abort", status: "cancelled" }],
    });
    a.rt.stateful.request = vi.fn((method: string, params: unknown) => {
      const out = Promise.resolve(ok(method, method === "tools/call"
        ? { taskId: "t-abort", status: "working" } : { taskId: "t-abort", status: "cancelled" }));
      if (method === "tools/call") user.abort(new Error("user"));
      void params;
      return out;
    }) as never;
    const fu = await createExtendedFeatures({ id: "srv", runtime: a.rt, descriptor: descriptor(), db: dbU });
    await expect(fu.run("mcp_tasks", { action: "call", tool: "x" }, user.signal)).rejects.toThrow();
    expect(dbU.prepare("SELECT status FROM durable_task_handles WHERE task_id = 't-abort'").get()).toMatchObject({ status: "cancelled" });
    await fu.close();

    const dbS = openDb();
    const b = fakeRuntime(TASKS_CAP, {});
    const seen: string[] = [];
    let features!: Awaited<ReturnType<typeof createExtendedFeatures>>;
    b.rt.stateful.request = vi.fn((method: string) => {
      seen.push(method);
      void features.close();
      return Promise.resolve(ok(method, { taskId: "t-shut", status: "working" }));
    }) as never;
    features = await createExtendedFeatures({ id: "srv", runtime: b.rt, descriptor: descriptor(), db: dbS });
    await expect(features.run("mcp_tasks", { action: "call", tool: "x" }, new AbortController().signal)).rejects.toThrow();
    expect(seen).toEqual(["tools/call"]);
    expect(dbS.prepare("SELECT status FROM durable_task_handles WHERE task_id = 't-shut'").get()).toMatchObject({ status: "working" });
  });

  it("runs mcp_skills list/get/load/read_file/directory with manifest-bound consent and confined cache", async () => {
    const skillUri = "skill://demo/alpha";
    const fileUri = `${skillUri}/SKILL.md`;
    const bodyV1 = "---\nname: alpha\ndescription: Demo skill\nallowed-tools: [read_only]\n---\nHello v1\n";
    const bodyV2 = "---\nname: alpha\ndescription: Demo skill\nallowed-tools: [read_only]\n---\nHello v2\n";
    const skillV1 = {
      uri: skillUri,
      name: "alpha",
      description: "Demo skill",
      resources: "static",
      allowedTools: ["read_only"],
      files: [{ uri: fileUri, size: Buffer.byteLength(bodyV1), sha256: sha256(bodyV1) }],
    };
    const skillV2 = {
      ...skillV1,
      files: [{ uri: fileUri, size: Buffer.byteLength(bodyV2), sha256: sha256(bodyV2) }],
    };

    const caps = {
      resources: {},
      extensions: { "io.modelcontextprotocol/skills": { directoryRead: true } },
    };

    // 1. Without consent, load fails closed and read_file is blocked.
    const noConsent = await createExtendedFeatures({
      id: "sk",
      runtime: fakeRuntime(caps, { "skills/get": [skillV1] }).rt,
      descriptor: descriptor("sk"),
      db: openDb(),
    });
    const sig = new AbortController().signal;
    await expect(noConsent.run("mcp_skills", { action: "load", skillUri }, sig)).rejects.toThrow(/denied/);
    await expect(noConsent.run("mcp_skills", { action: "read_file", skillUri, fileUri }, sig)).rejects.toThrow(/not approved/);
    await noConsent.close();

    // 2. With consent + caller skillsCacheDir: list, get, load (manifest + tools approval), read_file (miss -> hit), directory, manifest change re-gates.
    const cacheDir = mkdtempSync(join(tmpdir(), "pi-durable-cache-test-"));
    dirs.push(cacheDir);
    let decision: "accept" | "decline" = "decline";
    const consent: ConsentPort = {
      request: vi.fn(async () => ({ decision })),
    };
    const { rt } = fakeRuntime(caps, {
      "skills/list": [{ skills: [skillV1] }],
      "skills/get": [skillV1, skillV1, skillV1, skillV2],
      "resources/read": [{ contents: [{ uri: fileUri, text: bodyV1 }] }],
      "resources/directory/read": [{ uris: [fileUri, "skill://demo/outside.txt"] }],
    });
    const features = await createExtendedFeatures({
      id: "sk",
      runtime: rt,
      descriptor: descriptor("sk"),
      db: openDb(),
      options: { consent, skillsCacheDir: cacheDir },
    });

    const listRes = await features.run("mcp_skills", { action: "list" }, sig) as { skills: unknown[] };
    expect(listRes.skills).toHaveLength(1);
    const getRes = await features.run("mcp_skills", { action: "get", skillUri }, sig) as { skill: { uri: string } };
    expect(getRes.skill.uri).toBe(skillUri);

    // Declined load throws
    await expect(features.run("mcp_skills", { action: "load", skillUri }, sig)).rejects.toThrow(/denied/);

    // Accepted load approves both manifest and allowedTools, enabling read_file + cache hit
    decision = "accept";
    expect(await features.run("mcp_skills", { action: "load", skillUri }, sig)).toEqual({ skillUri, approved: true });
    expect(await features.run("mcp_skills", { action: "read_file", skillUri, fileUri }, sig)).toEqual({
      uri: fileUri, fromCache: false, text: bodyV1,
    });
    expect(await features.run("mcp_skills", { action: "read_file", skillUri, fileUri }, sig)).toEqual({
      uri: fileUri, fromCache: true, text: bodyV1,
    });

    // Directory filters to retained manifest URIs
    expect(await features.run("mcp_skills", { action: "directory", skillUri }, sig)).toEqual({
      uris: [fileUri],
    });

    // Manifest update invalidates prior approval
    await features.run("mcp_skills", { action: "get", skillUri }, sig);
    await expect(features.run("mcp_skills", { action: "read_file", skillUri, fileUri }, sig)).rejects.toThrow(/not approved/);

    await features.close();
    // Caller-supplied skillsCacheDir is preserved after close
    expect(existsSync(join(cacheDir, "server-sk", ".mcp-skill-cache-exclude"))).toBe(true);
  });

  it("works end-to-end against live-ext-fixture.mjs for tasks and skills", async () => {
    const { startFixture, SKILL, SKILL_FILE, TASK } = await loadFixture();
    const fx = await startFixture();
    const db = openDb();
    let rt: DurableRuntime | undefined;
    try {
      // Authenticate against fixture OAuth (PKCE) just like fixtureHealth
      const as = await (await fetch(`${fx.base}/.well-known/oauth-authorization-server`)).json() as {
        authorization_endpoint: string; token_endpoint: string;
      };
      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const auth = new URL(as.authorization_endpoint);
      Object.entries({
        response_type: "code", redirect_uri: "http://127.0.0.1:1/cb",
        code_challenge: challenge, code_challenge_method: "S256", state: "s",
      }).forEach(([k, v]) => auth.searchParams.set(k, v));
      const loc = new URL((await fetch(auth, { redirect: "manual" })).headers.get("location")!);
      const tok = await (await fetch(as.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: loc.searchParams.get("code")!,
          code_verifier: verifier,
        }),
      })).json() as { access_token: string };

      const stateDir = mkdtempSync(join(tmpdir(), "pi-durable-live-test-"));
      dirs.push(stateDir);
      rt = await openRuntime({ name: "fixture", url: fx.mcpUrl }, {
        stateDir,
        authProvider: {
          contextId: () => "fixture",
          headerFor: async () => ({ contextId: "fixture", authorization: `Bearer ${tok.access_token}` }),
        },
      });
      expect((await rt.ready()).kind).toBe("ok");

      const deliver = vi.fn();
      const consent: ConsentPort = {
        request: vi.fn(async req => (
          req.kind === "form-elicitation"
            ? { decision: "accept" as const, content: { value: "fixture reply" } }
            : { decision: "accept" as const }
        )),
      };

      const features = await createExtendedFeatures({
        id: "fixture",
        runtime: rt,
        descriptor: descriptor("fixture"),
        db,
        options: { consent, deliver },
      });

      expect(features.names).toEqual(["mcp_tasks", "mcp_skills"]);
      const sig = new AbortController().signal;

      // Task call -> working -> tasks/get (input_required) -> consent -> tasks/update -> completed
      const started = await features.run("mcp_tasks", { action: "call", tool: "ask", arguments: {} }, sig);
      expect(started).toEqual({ taskId: TASK, status: "working" });
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
        kind: "task",
        serverId: "fixture",
        taskId: TASK,
        status: "completed",
      })));
      const fetched = await features.run("mcp_tasks", { action: "get", taskId: TASK }, sig) as { taskId: string; status: string };
      expect(fetched).toMatchObject({ taskId: TASK, status: "completed" });

      // Skills list -> get -> load (consent) -> read_file (miss -> hit)
      const listed = await features.run("mcp_skills", { action: "list" }, sig) as { skills: Array<{ uri: string }> };
      expect(listed.skills.map(s => s.uri)).toEqual([SKILL]);
      expect(await features.run("mcp_skills", { action: "load", skillUri: SKILL }, sig)).toEqual({
        skillUri: SKILL, approved: true,
      });
      const f1 = await features.run("mcp_skills", { action: "read_file", skillUri: SKILL, fileUri: SKILL_FILE }, sig) as {
        uri: string; fromCache: boolean; text: string;
      };
      expect(f1.fromCache).toBe(false);
      expect(f1.text).toContain("Fixture skill instructions.");
      const f2 = await features.run("mcp_skills", { action: "read_file", skillUri: SKILL, fileUri: SKILL_FILE }, sig) as {
        uri: string; fromCache: boolean; text: string;
      };
      expect(f2.fromCache).toBe(true);
      expect(f2.text).toBe(f1.text);

      await features.close();
    } finally {
      await rt?.close();
      await fx.close();
    }
  });
});
