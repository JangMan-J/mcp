import { spawn, type ChildProcess } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import {
  JSONRPC_VERSION,
  parseInboundMessage,
  systemClock,
  type Clock,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type RequestId,
  type Transport,
  type TransportCall,
  type TransportDiagnostic,
  type TransportFailure,
} from "@mcp-client/core";
import { DEFAULT_MAX_DIAGNOSTICS, DiagnosticChannel } from "./diagnostics.js";
import { DEFAULT_MAX_LINE_BYTES, encodeStdioMessage, LineSplitter } from "./framing.js";
import {
  DEFAULT_STDERR_MAX_BYTES,
  DEFAULT_STDERR_MAX_LINE_BYTES,
  StderrRingBuffer,
} from "./stderr-ring.js";
import { WriteQueue, type WriteState } from "./write-queue.js";

export const META_PROGRESS_TOKEN = "io.modelcontextprotocol/progressToken" as const;
export const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId" as const;

export const DEFAULT_MAX_NOISE_LINES = 100;
export const DEFAULT_MAX_NOISE_BYTES = 1 * 1024 * 1024; // 1 MiB
export const DEFAULT_GRACE_MS = 2000;
export const DEFAULT_TERM_MS = 2000;
export const DEFAULT_MAX_RESTARTS = 3;
export const DEFAULT_RESTART_WINDOW_MS = 60_000;
export const DEFAULT_RESTART_BACKOFF_MS = 100;

/**
 * Default read-only methods eligible for retry after crash (IMPLEMENTATION_PLAN §6.5, STDIO-RECOVER-1).
 * `tools/call` is NEVER on this list.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "completion/complete",
  "subscriptions/listen",
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}

export type StdioTransportState = "idle" | "spawning" | "ready" | "closing" | "closed" | "failed";

export interface StdioRestartPolicy {
  readonly policy: "on-demand" | "auto";
  readonly maxRestarts?: number;
  readonly windowMs?: number;
  readonly backoffMs?: number;
}

export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** Explicit allow-list of keys to inherit from process.env; defaults to minimal PATH resolution keys. */
  readonly inheritEnv?: readonly string[];
  readonly maxLineBytes?: number;
  readonly maxNoiseLines?: number;
  readonly maxNoiseBytes?: number;
  readonly stderrMaxBytes?: number;
  readonly stderrMaxLineBytes?: number;
  readonly onStderr?: (line: string) => void;
  readonly graceMs?: number;
  readonly termMs?: number;
  readonly restart?: StdioRestartPolicy;
  readonly clock?: Clock;
  readonly maxDiagnostics?: number;
  /** Optional spawn override for unit testing launch parameters (STDIO-LAUNCH-1). */
  readonly spawnFn?: typeof spawn;
}

class NotificationQueue implements AsyncIterable<JsonRpcNotification> {
  private readonly items: JsonRpcNotification[] = [];
  private readonly waiters: Array<(res: IteratorResult<JsonRpcNotification>) => void> = [];
  private ended = false;

  push(n: JsonRpcNotification): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: n, done: false });
    } else {
      this.items.push(n);
    }
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
    return {
      next: (): Promise<IteratorResult<JsonRpcNotification>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

interface PendingRequest {
  readonly key: string;
  readonly id: RequestId;
  readonly method: string;
  readonly progressTokenKey?: string;
  readonly notifications: NotificationQueue;
  readonly resolve: (end: ExchangeEnd) => void;
  readonly onAbort?: () => void;
  readonly signal: AbortSignal;
  writeState: WriteState;
  settled: boolean;
}

interface ChildRun {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  disconnected: boolean;
  eofMidLine?: boolean;
  shutdown?: Promise<void>;
}

function keyOfId(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function buildChildEnv(
  explicitEnv: Readonly<Record<string, string>> | undefined,
  inheritEnv: readonly string[] | undefined,
): Record<string, string> {
  const allow = inheritEnv ?? (process.platform === "win32" ? ["PATH", "SystemRoot", "PATHEXT"] : ["PATH"]);
  const out: Record<string, string> = {};
  for (const k of allow) {
    const val = process.env[k];
    if (val !== undefined) {
      out[k] = val;
    }
  }
  if (explicitEnv) {
    for (const [k, v] of Object.entries(explicitEnv)) {
      out[k] = v;
    }
  }
  return out;
}

export class StdioTransport implements Transport {
  readonly binding = "stdio" as const;

  private readonly command: string;
  private readonly args: readonly string[];
  private readonly cwd?: string;
  private readonly childEnv: Record<string, string>;
  private readonly maxLineBytes: number;
  private readonly maxNoiseLines: number;
  private readonly maxNoiseBytes: number;
  private readonly graceMs: number;
  private readonly termMs: number;
  private readonly restartPolicy: "on-demand" | "auto";
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly restartBackoffMs: number;
  private readonly clock: Clock;
  private readonly spawnFn: typeof spawn;

  private readonly diagChannel: DiagnosticChannel;
  private readonly stderrRing: StderrRingBuffer;
  private readonly writeQueue = new WriteQueue();
  private readonly splitter: LineSplitter;

  private readonly pending = new Map<string, PendingRequest>();
  private readonly progressMap = new Map<string, PendingRequest>();
  private readonly subscriptionListeners = new Map<string, Set<(n: JsonRpcNotification) => void>>();
  private readonly settledIds: string[] = [];
  private readonly settledIdSet = new Set<string>();

  private _state: StdioTransportState = "idle";
  private run: ChildRun | undefined;
  private closing: Promise<void> | undefined;
  private hasSpawnedOnce = false;
  private readonly restartTimestamps: number[] = [];
  private cancelRestartTimer: (() => void) | undefined;
  private noiseLines = 0;
  private noiseBytes = 0;
  private fatalFailure: TransportFailure | undefined;

  constructor(opts: StdioTransportOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    if (opts.cwd !== undefined) {
      this.cwd = opts.cwd;
    }
    this.childEnv = buildChildEnv(opts.env, opts.inheritEnv);
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.maxNoiseLines = opts.maxNoiseLines ?? DEFAULT_MAX_NOISE_LINES;
    this.maxNoiseBytes = opts.maxNoiseBytes ?? DEFAULT_MAX_NOISE_BYTES;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.termMs = opts.termMs ?? DEFAULT_TERM_MS;
    this.restartPolicy = opts.restart?.policy ?? "on-demand";
    this.maxRestarts = opts.restart?.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.restartWindowMs = opts.restart?.windowMs ?? DEFAULT_RESTART_WINDOW_MS;
    this.restartBackoffMs = opts.restart?.backoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
    this.clock = opts.clock ?? systemClock;
    this.spawnFn = opts.spawnFn ?? spawn;

    this.diagChannel = new DiagnosticChannel(opts.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS);
    this.splitter = new LineSplitter(this.maxLineBytes);
    this.stderrRing = new StderrRingBuffer({
      maxTotalBytes: opts.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
      maxLineBytes: opts.stderrMaxLineBytes ?? DEFAULT_STDERR_MAX_LINE_BYTES,
      onLine: (line) => {
        this.emitDiag("stderr", line);
        opts.onStderr?.(line);
      },
    });
  }

  get state(): StdioTransportState {
    return this._state;
  }

  get pid(): number | undefined {
    return this.run?.child.pid;
  }

  get diagnostics(): AsyncIterable<TransportDiagnostic> {
    return this.diagChannel;
  }

  stderrSnapshot(): readonly string[] {
    return this.stderrRing.snapshot();
  }

  diagnosticsSnapshot(): readonly TransportDiagnostic[] {
    return this.diagChannel.snapshot();
  }

  /**
   * Registers an external listener for notifications matching `io.modelcontextprotocol/subscriptionId` (STDIO-ROUTE-2).
   */
  registerSubscription(subscriptionId: RequestId, listener: (n: JsonRpcNotification) => void): () => void {
    const key = keyOfId(subscriptionId);
    let set = this.subscriptionListeners.get(key);
    if (!set) {
      set = new Set();
      this.subscriptionListeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.subscriptionListeners.get(key) === set) {
        this.subscriptionListeners.delete(key);
      }
    };
  }

  start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
    const notifications = new NotificationQueue();

    // Validate outbound message shape & framing before doing anything (WIRE-DIR-1, STDIO-FRAME-1, STDIO-STDIN-1)
    const payload = encodeStdioMessage(msg);

    // Abort before send -> zero wire bytes (EDGE-6, STDIO-CANCEL-1)
    if (ctx.signal.aborted) {
      notifications.close();
      return {
        notifications,
        done: Promise.resolve({
          kind: "failure",
          failure: { kind: "closed", message: "aborted before send" },
          delivery: "not-sent",
        }),
      };
    }

    if (this._state === "closing" || this._state === "closed") {
      notifications.close();
      return {
        notifications,
        done: Promise.resolve({
          kind: "failure",
          failure: { kind: "closed", message: "StdioTransport is closed" },
          delivery: "not-sent",
        }),
      };
    }

    if (this._state === "failed") {
      notifications.close();
      return {
        notifications,
        done: Promise.resolve({
          kind: "failure",
          failure: this.fatalFailure ?? { kind: "process-exit", message: "StdioTransport is in failed state" },
          delivery: "not-sent",
        }),
      };
    }

    const spawnErr = this.ensureStarted();
    if (spawnErr) {
      notifications.close();
      return {
        notifications,
        done: Promise.resolve({
          kind: "failure",
          failure: spawnErr,
          delivery: "not-sent",
        }),
      };
    }

    const reqKey = keyOfId(msg.id);
    const meta =
      msg.params && typeof msg.params["_meta"] === "object" && msg.params["_meta"] !== null
        ? (msg.params["_meta"] as Record<string, unknown>)
        : undefined;
    const rawProgressToken = meta?.[META_PROGRESS_TOKEN];
    const progressTokenKey =
      typeof rawProgressToken === "string" || typeof rawProgressToken === "number"
        ? keyOfId(rawProgressToken)
        : undefined;
    if (this.pending.has(reqKey)) throw new Error(`Duplicate in-flight request id=${reqKey}`);

    let resolveDone!: (end: ExchangeEnd) => void;
    const done = new Promise<ExchangeEnd>((resolve) => {
      resolveDone = resolve;
    });

    const entry: PendingRequest = {
      key: reqKey,
      id: msg.id,
      method: msg.method,
      ...(progressTokenKey !== undefined ? { progressTokenKey } : {}),
      notifications,
      resolve: resolveDone,
      signal: ctx.signal,
      writeState: "queued",
      settled: false,
    };

    const onAbort = () => {
      this.handleRequestAbort(entry);
    };
    (entry as { onAbort?: () => void }).onAbort = onAbort;
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    this.pending.set(reqKey, entry);
    if (progressTokenKey !== undefined) {
      this.progressMap.set(progressTokenKey, entry);
    }

    this.writeQueue
      .enqueue({
        payload,
        key: reqKey,
        priority: false,
        onStateChange: (st) => {
          entry.writeState = st;
        },
      })
      .catch((err: unknown) => {
        if (entry.settled || this.run?.disconnected) return;
        const message = err instanceof Error ? err.message : String(err);
        if (message === "removed-from-queue") return;
        this.settlePending(entry, {
          kind: "failure",
          failure: { kind: "stream-broken", message: `stdin write failed: ${message}`, cause: err },
          delivery: this.deliveryForWriteState(entry.writeState),
        });
      });

    return { notifications, done };
  }

  async notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void> {
    const payload = encodeStdioMessage(msg);
    if (ctx.signal.aborted) return;
    if (this._state === "closing" || this._state === "closed" || this._state === "failed") {
      throw new Error(`Cannot send notification while StdioTransport is ${this._state}`);
    }
    const spawnErr = this.ensureStarted();
    if (spawnErr) {
      throw new Error(spawnErr.message);
    }
    const isCancel = msg.method === "notifications/cancelled";
    await this.writeQueue.enqueue({ payload, priority: isCancel });
  }

  close(opts?: { readonly graceMs?: number; readonly termMs?: number }): Promise<void> {
    return this.closing ??= this.closeTransport(opts);
  }

  private async closeTransport(opts?: { readonly graceMs?: number; readonly termMs?: number }): Promise<void> {
    this._state = "closing";
    this.cancelRestartTimer?.();
    this.cancelRestartTimer = undefined;

    // Settle all pending requests with delivery certainty (6.3 / 6.5)
    this.settleAllPending({ kind: "closed", message: "StdioTransport closing" });
    this.writeQueue.detach(new Error("transport closing"));

    const run = this.run;
    if (run) {
      await this.stopChild(run, opts?.graceMs ?? this.graceMs, opts?.termMs ?? this.termMs);
    }
    this.subscriptionListeners.clear();
    this._state = "closed";
    this.diagChannel.close();
  }

  private ensureStarted(): TransportFailure | undefined {
    if (this.run) {
      const { child, disconnected } = this.run;
      return disconnected || child.exitCode !== null || child.signalCode !== null
        ? { kind: "process-exit", message: "Previous child is shutting down" }
        : undefined;
    }

    // Cancel any scheduled auto-restart since we are spawning now
    this.cancelRestartTimer?.();
    this.cancelRestartTimer = undefined;

    if (this.hasSpawnedOnce) {
      const now = this.clock.now();
      this.pruneRestartWindow(now);
      if (this.restartTimestamps.length >= this.maxRestarts) {
        const failure: TransportFailure = {
          kind: "process-exit",
          message: `Restart loop guard tripped (${this.maxRestarts} restarts within ${this.restartWindowMs}ms)`,
        };
        this.fatalFailure = failure;
        this._state = "failed";
        this.emitDiag("lifecycle", failure.message);
        return failure;
      }
      this.restartTimestamps.push(now);
      this.emitDiag("lifecycle", `restarting child process (attempt ${this.restartTimestamps.length}/${this.maxRestarts})`);
    }

    this.hasSpawnedOnce = true;
    this._state = "spawning";
    this.noiseLines = 0;
    this.noiseBytes = 0;
    this.splitter.reset();

    let child: ChildProcess;
    try {
      // STDIO-LAUNCH-1: shell: false, windowsHide: true, stdio: pipe
      child = this.spawnFn(this.command, [...this.args], {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
        env: this.childEnv,
      });
    } catch (err) {
      const failure: TransportFailure = {
        kind: "spawn",
        message: `Failed to spawn '${this.command}': ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      };
      this.fatalFailure = failure;
      this._state = "failed";
      this.emitDiag("lifecycle", failure.message);
      return failure;
    }

    const run: ChildRun = {
      child,
      closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
      disconnected: false,
    };
    this.run = run;

    child.once("spawn", () => {
      if (this._state !== "spawning") return;
      this._state = "ready";
      this.emitDiag("lifecycle", `spawned pid=${String(child.pid)} command=${this.command}`);
      if (child.stdin) this.writeQueue.attach(child.stdin);
    });
    child.stdin?.on("error", (err) => {
      this.emitDiag("lifecycle", `stdin error: ${err.message}`);
      this.disconnect(run);
    });
    child.stdin?.once("close", () => this.disconnect(run));
    child.stdout?.on("error", (err) => {
      this.emitDiag("lifecycle", `stdout error: ${err.message}`);
      this.disconnect(run);
    });
    child.stdout?.on("data", (chunk: Uint8Array) => {
      if (this._state === "ready") this.handleStdoutChunk(chunk);
    });
    child.stdout?.once("end", () => {
      const rem = this.splitter.flushRemainderPreview();
      if (rem) {
        run.eofMidLine = true;
        this.emitDiag("violation", `eof-mid-line: ${rem.byteLength} trailing bytes without newline: ${rem.preview}`);
      }
      this.disconnect(run);
    });
    child.stderr?.on("data", (chunk: Uint8Array) => this.stderrRing.push(chunk));
    child.stderr?.once("end", () => this.stderrRing.flush());

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this._state !== "spawning") {
        this.emitDiag("lifecycle", `child process error: ${err.message}`);
        return;
      }
      const failure: TransportFailure = {
        kind: "spawn",
        message: `Failed to spawn '${this.command}' (${err.code ?? "ERR"}): ${err.message}`,
        cause: err,
      };
      this.fatalFailure = failure;
      this._state = "failed";
      this.emitDiag("lifecycle", failure.message);
      this.writeQueue.detach(err);
      this.settleAllPending(failure);
    });

    child.once("close", (code, signal) => {
      this.run = undefined;
      this.handleUnexpectedClose(code, signal, run.eofMidLine === true);
    });

    return undefined;
  }

  private handleStdoutChunk(chunk: Uint8Array): void {
    const events = this.splitter.push(chunk);
    for (const ev of events) {
      if (ev.kind === "oversize") {
        const failure: TransportFailure = {
          kind: "too-large",
          message: `Oversize stdout line (${ev.byteLength} bytes > ${ev.maxLineBytes} maxLineBytes)`,
        };
        this.emitDiag("violation", failure.message);
        this.failTransportAndKill(failure);
        return;
      }
      if (ev.kind === "invalid-utf8") {
        this.emitDiag("violation", `invalid-utf8 (${ev.byteLength} bytes): ${ev.preview}`);
        if (this.recordNoise(ev.byteLength)) return;
        continue;
      }
      this.handleInboundLine(ev.text, ev.byteLength);
      if (this._state === "failed" || this._state === "closing" || this._state === "closed") {
        return;
      }
    }
  }

  private handleInboundLine(text: string, byteLength: number): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      const preview = text.length > 256 ? text.slice(0, 256) : text;
      this.emitDiag("noise", `stdout-noise: ${preview}`);
      this.recordNoise(byteLength);
      return;
    }

    // STDIO-BATCH-1: JSON-RPC batch/array is a protocol violation
    if (Array.isArray(parsedJson)) {
      this.emitDiag("violation", "protocol-violation: JSON-RPC batch array is not supported (STDIO-BATCH-1)");
      // If any element references an in-flight request id, fail it so callers do not hang
      for (const elem of parsedJson) {
        if (typeof elem === "object" && elem !== null && "id" in elem) {
          const id = (elem as Record<string, unknown>)["id"];
          if (typeof id === "string" || typeof id === "number") {
            const entry = this.pending.get(keyOfId(id));
            if (entry) {
              this.settlePending(entry, {
                kind: "failure",
                failure: {
                  kind: "stream-broken",
                  message: "protocol-violation: JSON-RPC batch array rejected (STDIO-BATCH-1)",
                },
                delivery: this.deliveryForWriteState(entry.writeState),
              });
            }
          }
        }
      }
      this.recordNoise(byteLength);
      return;
    }

    const parsed = parseInboundMessage(parsedJson);
    if ("error" in parsed) {
      const preview = text.length > 256 ? text.slice(0, 256) : text;
      this.emitDiag("noise", `stdout-noise (${parsed.error}): ${preview}`);
      this.recordNoise(byteLength);
      return;
    }

    for (const d of parsed.diagnostics) {
      this.emitDiag("violation", d);
    }

    if (parsed.kind === "server-request") {
      // WIRE-DIR-2 / EDGE-35: never reply to server-initiated JSON-RPC requests
      this.emitDiag(
        "violation",
        `server-initiated request ignored without reply: method=${(parsed.message as JsonRpcRequest).method}`,
      );
      this.recordNoise(byteLength);
      return;
    }

    if (parsed.kind === "notification") {
      this.routeNotification(parsed.message as JsonRpcNotification);
      return;
    }

    // Response or error response
    const msg = parsed.message;
    if (!("id" in msg) || msg.id === null || (typeof msg.id !== "string" && typeof msg.id !== "number")) {
      // WIRE-ERR-2 / EDGE-4: error with null/missing id is diagnostic only
      this.emitDiag("violation", "uncorrelated error response with null/missing id");
      return;
    }

    const reqKey = keyOfId(msg.id);
    const entry = this.pending.get(reqKey);
    if (!entry) {
      if (this.settledIdSet.has(reqKey)) {
        // EDGE-2 / WIRE-CANCEL-3: duplicate or late response
        this.emitDiag("violation", `duplicate-or-late-response for id=${String(msg.id)}`);
      } else {
        // EDGE-3: unknown id or id type mismatch
        this.emitDiag("noise", `unknown response id=${reqKey}`);
      }
      return;
    }

    this.settlePending(entry, {
      kind: "response",
      message: msg as Exclude<typeof msg, JsonRpcNotification | JsonRpcRequest>,
    });
  }

  private routeNotification(notif: JsonRpcNotification): void {
    // WIRE-LOG-1 / EDGE-33: deprecated logging notifications dropped
    if (notif.method === "notifications/message") {
      this.emitDiag("noise", "dropped deprecated notifications/message");
      return;
    }

    // STDIO-ROUTE-1: progress notifications by progressToken
    if (notif.method === "notifications/progress" && notif.params) {
      const token = notif.params["progressToken"];
      if (typeof token === "string" || typeof token === "number") {
        const entry = this.progressMap.get(keyOfId(token));
        if (entry && !entry.settled) {
          entry.notifications.push(notif);
          return;
        }
      }
      this.emitDiag("noise", `dropped progress notification for inactive token`);
      return;
    }

    // STDIO-ROUTE-2: subscription notifications by _meta["io.modelcontextprotocol/subscriptionId"]
    const meta =
      notif.params && typeof notif.params["_meta"] === "object" && notif.params["_meta"] !== null
        ? (notif.params["_meta"] as Record<string, unknown>)
        : undefined;
    const subId = meta?.[META_SUBSCRIPTION_ID];
    if ((typeof subId === "string" && subId.length > 0) || (typeof subId === "number" && Number.isInteger(subId))) {
      const key = keyOfId(subId);
      let delivered = false;
      const entry = this.pending.get(key);
      if (entry?.method === "subscriptions/listen") {
        entry.notifications.push(notif);
        delivered = true;
      }
      const listeners = this.subscriptionListeners.get(key);
      if (listeners && listeners.size > 0) {
        for (const fn of listeners) {
          fn(notif);
        }
        delivered = true;
      }
      if (!delivered) {
        this.emitDiag("noise", `unroutable subscription notification for subscriptionId=${subId}`);
      }
      return;
    }

    // WIRE-CANCEL-4: server notifications/cancelled only for subscriptions/listen ids
    if (notif.method === "notifications/cancelled" && notif.params) {
      const reqId = notif.params["requestId"];
      if (typeof reqId === "string" || typeof reqId === "number") {
        const entry = this.pending.get(keyOfId(reqId));
        if (entry && !entry.settled && entry.method === "subscriptions/listen") {
          entry.notifications.push(notif);
          return;
        }
      }
      this.emitDiag("noise", "ignored server notifications/cancelled for non-listen request");
      return;
    }

    this.emitDiag("noise", `unroutable notification: method=${notif.method}`);
  }

  private recordNoise(byteLength: number): boolean {
    this.noiseLines += 1;
    this.noiseBytes += byteLength;
    if (this.noiseLines > this.maxNoiseLines || this.noiseBytes > this.maxNoiseBytes) {
      const failure: TransportFailure = {
        kind: "stream-broken",
        message: `protocol-noise: stdout noise budget exceeded (${this.noiseLines} lines, ${this.noiseBytes} bytes)`,
      };
      this.emitDiag("violation", failure.message);
      this.failTransportAndKill(failure);
      return true;
    }
    return false;
  }

  private handleRequestAbort(entry: PendingRequest): void {
    if (entry.settled) return;

    // STDIO-CANCEL-1: queued unsent request is removed without writing to stdin
    if (entry.writeState === "queued" && this.writeQueue.removeQueued(entry.key)) {
      this.settlePending(entry, {
        kind: "failure",
        failure: { kind: "closed", message: "cancelled while queued" },
        delivery: "not-sent",
      });
      return;
    }

    // Already writing or sent -> send priority notifications/cancelled
    const delivery = this.deliveryForWriteState(entry.writeState);
    const reason = typeof entry.signal.reason === "string" ? entry.signal.reason : undefined;
    const cancelMsg: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: "notifications/cancelled",
      params: {
        requestId: entry.id,
        ...(reason !== undefined ? { reason } : {}),
      },
    };
    if ((this._state === "ready" || this._state === "spawning") && !this.run?.disconnected) {
      this.writeQueue
        .enqueue({
          payload: encodeStdioMessage(cancelMsg),
          priority: true,
        })
        .catch(() => {});
    }

    this.settlePending(entry, {
      kind: "failure",
      failure: { kind: "closed", message: "request cancelled" },
      delivery,
    });
  }

  private disconnect(run: ChildRun): void {
    if (this.run !== run || this._state !== "ready" || run.disconnected) return;
    run.disconnected = true;
    this.writeQueue.detach(new Error("child pipe disconnected"));
    // Drain any last replies and reap before another child can own the pipes.
    this.retireChild(run);
  }

  private handleUnexpectedClose(code: number | null, signal: NodeJS.Signals | null, eofMidLine: boolean): void {
    if (this._state === "closing" || this._state === "closed" || this._state === "failed") {
      return;
    }

    const detail = `child process exited unexpectedly (code=${String(code)}, signal=${String(signal)})${eofMidLine ? ": eof-mid-line" : ""}`;
    this.emitDiag("lifecycle", detail);

    const failure: TransportFailure = {
      kind: "process-exit",
      message: detail,
    };
    this.writeQueue.detach(new Error(detail));
    this.settleAllPending(failure);

    if (this.restartPolicy === "auto") {
      const now = this.clock.now();
      this.pruneRestartWindow(now);
      if (this.restartTimestamps.length >= this.maxRestarts) {
        const guardFailure: TransportFailure = {
          kind: "process-exit",
          message: `Restart loop guard tripped (${this.maxRestarts} restarts within ${this.restartWindowMs}ms)`,
        };
        this.fatalFailure = guardFailure;
        this._state = "failed";
        this.emitDiag("lifecycle", guardFailure.message);
        return;
      }
      this._state = "idle";
      this.cancelRestartTimer = this.clock.setTimeout(() => {
        this.cancelRestartTimer = undefined;
        if (this._state === "idle") {
          this.ensureStarted();
        }
      }, this.restartBackoffMs);
    } else {
      // on-demand: return to idle; next request will respawn (checked against restart loop guard)
      this._state = "idle";
    }
  }

  private failTransportAndKill(failure: TransportFailure): void {
    this.fatalFailure = failure;
    this._state = "failed";
    this.cancelRestartTimer?.();
    this.cancelRestartTimer = undefined;
    this.writeQueue.detach(new Error(failure.message));
    this.settleAllPending(failure);

    if (this.run) this.retireChild(this.run);
  }

  private retireChild(run: ChildRun): void {
    void this.stopChild(run, this.graceMs, this.termMs).catch((err: unknown) => {
      this.emitDiag("lifecycle", `child shutdown failed: ${String(err)}`);
    });
  }

  private stopChild(run: ChildRun, graceMs: number, termMs: number): Promise<void> {
    return run.shutdown ??= this.shutdownChildLadder(run, graceMs, termMs);
  }

  private async shutdownChildLadder({ child, closed }: ChildRun, graceMs: number, termMs: number): Promise<void> {
    const waitForClose = (ms: number) => new Promise<boolean>((resolve) => {
      // Shutdown deadlines are independent of the injected protocol clock.
      const timer = setTimeout(() => resolve(false), ms);
      void closed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    const exited = () => child.exitCode !== null || child.signalCode !== null;

    child.stdin?.end();
    if (await waitForClose(graceMs)) return;
    if (!exited() && child.pid !== undefined) {
      this.emitDiag("lifecycle", `shutdown escalation: sending SIGTERM to pid=${child.pid}`);
      child.kill("SIGTERM");
      if (await waitForClose(termMs)) return;
      if (!exited()) {
        this.emitDiag("lifecycle", `shutdown escalation: sending SIGKILL to pid=${child.pid}`);
        child.kill("SIGKILL");
      }
    }
    if (!await waitForClose(2000)) throw new Error(`Child pid=${child.pid} did not close after shutdown`);
  }

  private settlePending(entry: PendingRequest, end: ExchangeEnd): void {
    if (entry.settled) return;
    entry.settled = true;
    this.pending.delete(entry.key);
    if (entry.progressTokenKey !== undefined) {
      this.progressMap.delete(entry.progressTokenKey);
    }
    if (entry.onAbort) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    this.recordSettledId(entry.key);
    entry.notifications.close();
    entry.resolve(end);
  }

  private settleAllPending(failure: TransportFailure): void {
    for (const entry of [...this.pending.values()]) {
      this.settlePending(entry, {
        kind: "failure",
        failure,
        delivery: this.deliveryForWriteState(entry.writeState),
      });
    }
  }

  private deliveryForWriteState(st: WriteState): "not-sent" | "maybe-delivered" | "delivered-no-response" {
    if (st === "queued") return "not-sent";
    if (st === "writing") return "maybe-delivered";
    return "delivered-no-response";
  }

  private recordSettledId(key: string): void {
    if (this.settledIdSet.has(key)) return;
    this.settledIdSet.add(key);
    this.settledIds.push(key);
    if (this.settledIds.length > 1000) {
      const oldest = this.settledIds.shift()!;
      this.settledIdSet.delete(oldest);
    }
  }

  private pruneRestartWindow(now: number): void {
    const cutoff = now - this.restartWindowMs;
    while (this.restartTimestamps.length > 0 && this.restartTimestamps[0]! < cutoff) {
      this.restartTimestamps.shift();
    }
  }

  private emitDiag(kind: TransportDiagnostic["kind"], message: string): void {
    this.diagChannel.emit({
      kind,
      message,
      atMs: this.clock.now(),
    });
  }
}
