import {
  SUPPORTED_PROTOCOL_VERSION,
  parseInboundMessage,
  systemClock,
  type AuthProvider,
  type Clock,
  type Exchange,
  type ExchangeEnd,
  type FetchPort,
  type JsonRpcErrorResponse,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type LoggerPort,
  type Transport,
  type TransportCall,
  type TransportDiagnostic,
  type TransportFailure,
} from "@mcp-client/core";
import { DiagnosticChannel, NotificationQueue } from "./diagnostics.js";
import {
  encodeHeaderValue,
  extractAtPath,
  validateXmcpHeaderSchema,
  type AnnotatedParam,
} from "./headers.js";
import { SseParser, DEFAULT_MAX_SSE_EVENT_BYTES } from "./sse.js";

export const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024; // HTTP-LIMIT-1
export const DEFAULT_MAX_SSE_STREAM_BYTES = 64 * 1024 * 1024; // HTTP-LIMIT-3
export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_LISTEN_IDLE_MS = 120_000;

const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_PROGRESS_TOKEN = "io.modelcontextprotocol/progressToken";
const META_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const FORBIDDEN_OUTBOUND = new Set(["mcp-session-id", "last-event-id"]);

export interface HttpTransportOptions {
  readonly url: string;
  /** Injected fetch via core FetchPort; defaults to globalThis.fetch. */
  readonly fetchPort?: FetchPort;
  readonly fetchFn?: (input: string, init: RequestInit) => Promise<Response>;
  readonly authProvider?: AuthProvider;
  readonly logger?: LoggerPort;
  readonly clock?: Clock;
  readonly protocolVersion?: string;
  readonly maxJsonBytes?: number;
  readonly maxSseEventBytes?: number;
  readonly maxSseStreamBytes?: number;
  readonly maxRedirects?: number;
  /** Idle-byte timeout for non-listen streams; 0 disables (ctx.timeoutMs used by default). */
  readonly idleTimeoutMs?: number;
  readonly listenIdleMs?: number;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly maxDiagnostics?: number;
}

type AttemptOutcome =
  | { readonly kind: "final"; readonly end: ExchangeEnd }
  | { readonly kind: "auth-retry" }
  | { readonly kind: "header-mismatch"; readonly message: JsonRpcErrorResponse };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class HttpTransport implements Transport {
  readonly binding = "streamable-http" as const;

  private readonly url: string;
  private readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly authProvider?: AuthProvider;
  private readonly logger?: LoggerPort;
  private readonly clock: Clock;
  private readonly protocolVersion?: string;
  private readonly maxJsonBytes: number;
  private readonly maxSseEventBytes: number;
  private readonly maxSseStreamBytes: number;
  private readonly maxRedirects: number;
  private readonly idleTimeoutMs?: number;
  private readonly listenIdleMs: number;
  private readonly extraHeaders: Readonly<Record<string, string>>;
  private readonly diag: DiagnosticChannel;
  private readonly toolParams = new Map<string, readonly AnnotatedParam[]>();
  private readonly inFlight = new Set<AbortController>();
  private closed = false;
  /** Last Retry-After observed on a 429/408/5xx response (HTTP-ERR-8), for hosts/tests. */
  lastRetryAfter: string | undefined;

  constructor(opts: HttpTransportOptions) {
    this.url = opts.url;
    if (opts.fetchFn) this.doFetch = opts.fetchFn;
    else if (opts.fetchPort) this.doFetch = (i, init) => opts.fetchPort!.fetch(i, init);
    else this.doFetch = (i, init) => globalThis.fetch(i, init);
    if (opts.authProvider) this.authProvider = opts.authProvider;
    if (opts.logger) this.logger = opts.logger;
    this.clock = opts.clock ?? systemClock;
    if (opts.protocolVersion) this.protocolVersion = opts.protocolVersion;
    this.maxJsonBytes = opts.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;
    this.maxSseEventBytes = opts.maxSseEventBytes ?? DEFAULT_MAX_SSE_EVENT_BYTES;
    this.maxSseStreamBytes = opts.maxSseStreamBytes ?? DEFAULT_MAX_SSE_STREAM_BYTES;
    this.maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    if (opts.idleTimeoutMs !== undefined) this.idleTimeoutMs = opts.idleTimeoutMs;
    this.listenIdleMs = opts.listenIdleMs ?? DEFAULT_LISTEN_IDLE_MS;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.diag = new DiagnosticChannel(opts.maxDiagnostics);
  }

  get diagnostics(): AsyncIterable<TransportDiagnostic> {
    return this.diag;
  }

  diagnosticsSnapshot(): readonly TransportDiagnostic[] {
    return this.diag.snapshot();
  }

  /** Annotated params cached from the most recent tools/list (HTTP-PARAM-5). */
  cachedToolParams(name: string): readonly AnnotatedParam[] | undefined {
    return this.toolParams.get(name);
  }

  start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
    const notifications = new NotificationQueue();
    const done = this.execute(msg, ctx, notifications).then(
      (end) => {
        notifications.close();
        return end;
      },
      (err: unknown) => {
        notifications.close();
        return {
          kind: "failure",
          failure: { kind: "stream-broken", message: err instanceof Error ? err.message : String(err), cause: err },
          delivery: "maybe-delivered",
        } satisfies ExchangeEnd;
      },
    );
    return { notifications, done };
  }

  async notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void> {
    if (this.closed) throw new Error("HttpTransport is closed");
    if (ctx.signal.aborted) return;
    // Extension notifications only: same version/method headers, expect 202 (HTTP-NOTIF-1).
    const outcome = await this.performOnce(msg, ctx, new NotificationQueue(), msg.method, undefined);
    if (outcome.kind === "auth-retry") {
      const retry = await this.performOnce(msg, ctx, new NotificationQueue(), msg.method, undefined);
      if (retry.kind !== "final") throw new Error("notification rejected after auth retry");
      if (retry.end.kind === "failure") throw new Error(retry.end.failure.message);
      return;
    }
    if (outcome.kind === "header-mismatch") throw new Error("notification rejected: header mismatch");
    if (outcome.end.kind === "failure") throw new Error(outcome.end.failure.message);
    // A response payload to a notification is tolerated/logged by performOnce classification.
  }

  async close(_opts?: { readonly graceMs?: number }): Promise<void> {
    this.closed = true;
    for (const c of this.inFlight) c.abort("transport closed");
    this.diag.close();
  }

  // ---- request execution ----

  private async execute(
    msg: JsonRpcRequest,
    ctx: TransportCall,
    notifications: NotificationQueue,
  ): Promise<ExchangeEnd> {
    if (this.closed) {
      return { kind: "failure", failure: { kind: "closed", message: "HttpTransport is closed" }, delivery: "not-sent" };
    }
    if (ctx.signal.aborted) {
      return { kind: "failure", failure: { kind: "closed", message: "aborted before send" }, delivery: "not-sent" };
    }
    let authRetried = false;
    let headerRetried = false;
    let wireId: JsonRpcRequest["id"] = msg.id;
    for (;;) {
      const wireMsg: JsonRpcRequest = wireId === msg.id ? msg : { ...msg, id: wireId };
      const outcome = await this.performOnce(wireMsg, ctx, notifications, msg.method, msg.id);
      if (outcome.kind === "auth-retry") {
        if (authRetried) {
          return {
            kind: "failure",
            failure: { kind: "forbidden", message: "auth challenge retry exhausted", status: 401 },
            delivery: "not-sent",
          };
        }
        authRetried = true;
        wireId = `${String(msg.id)}~auth-retry-1`;
        continue;
      }
      if (outcome.kind === "header-mismatch") {
        if (headerRetried || msg.method !== "tools/call") {
          return { kind: "response", message: outcome.message };
        }
        headerRetried = true;
        // HTTP-PARAM-6: refresh tools/list, rebuild headers, retry once with a new id.
        await this.refreshToolsList(msg, ctx);
        wireId = `${String(msg.id)}~header-retry-1`;
        continue;
      }
      return outcome.end;
    }
  }

  private async refreshToolsList(original: JsonRpcRequest, ctx: TransportCall): Promise<void> {
    const params = isRecord(original.params) ? original.params : {};
    const refresh: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: `${String(original.id)}~tools-list-refresh`,
      method: "tools/list",
      params: { ...(isRecord(params["_meta"]) ? { _meta: params["_meta"] } : {}) },
    };
    await this.performOnce(refresh, ctx, new NotificationQueue(), "tools/list", refresh.id).catch(() => undefined);
  }

  private async performOnce(
    wireMsg: JsonRpcRequest | JsonRpcNotification,
    ctx: TransportCall,
    notifications: NotificationQueue,
    method: string,
    expectedId: JsonRpcRequest["id"] | undefined,
  ): Promise<AttemptOutcome> {
    const isRequest = "id" in wireMsg;
    const controller = new AbortController();
    this.inFlight.add(controller);
    const onCallerAbort = () => controller.abort(ctx.signal.reason);
    if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
    else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });

    let timedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const isListen = method === "subscriptions/listen";
    const timeoutMs = isRequest ? ctx.timeoutMs : undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs && timeoutMs > 0 && !isListen) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort("timeout");
      }, timeoutMs);
    }
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const idleMs = this.idleTimeoutMs !== undefined ? this.idleTimeoutMs : isListen ? this.listenIdleMs : timeoutMs;
      if (idleMs && idleMs > 0) {
        idleTimer = setTimeout(() => {
          if (isListen) {
            this.emit("violation", `listen stream idle for ${idleMs}ms (watchdog)`);
            controller.abort("listen-idle");
          } else {
            timedOut = true;
            controller.abort("idle-timeout");
          }
        }, idleMs);
      }
    };

    try {
      const headers = await this.buildHeaders(wireMsg, ctx);
      const body = JSON.stringify(wireMsg);
      let currentUrl = this.url;
      let response: Response | undefined;
      let redirects = 0;
      for (;;) {
        try {
          response = await this.doFetch(currentUrl, {
            method: "POST", // POST only: never GET/DELETE (HTTP-NOGET-1)
            headers,
            body,
            redirect: "manual",
            signal: controller.signal,
          });
        } catch (err) {
          if (ctx.signal.aborted || controller.signal.aborted) {
            return {
              kind: "final",
              end: {
                kind: "failure",
                failure: {
                  kind: timedOut ? "timeout" : "closed",
                  message: timedOut ? `request timed out after ${String(timeoutMs)}ms` : "request aborted",
                  cause: err,
                },
                delivery: "maybe-delivered",
              },
            };
          }
          return {
            kind: "final",
            end: {
              kind: "failure",
              failure: { kind: "connect", message: `fetch failed: ${err instanceof Error ? err.message : String(err)}`, cause: err },
              delivery: "maybe-delivered",
            },
          };
        }
        const status = response.status;
        if (status >= 300 && status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location || (status !== 307 && status !== 308)) {
            return {
              kind: "final",
              end: {
                kind: "failure",
                failure: { kind: "http-status", message: `redirect ${status} not followed (only 307/308 preserve POST)`, status },
                delivery: "not-sent",
              },
            };
          }
          if (redirects >= this.maxRedirects) {
            return {
              kind: "final",
              end: {
                kind: "failure",
                failure: { kind: "http-status", message: `too many redirects (>${this.maxRedirects})`, status },
                delivery: "not-sent",
              },
            };
          }
          const next = new URL(location, currentUrl);
          const prev = new URL(currentUrl);
          if (next.origin !== prev.origin || (prev.protocol === "https:" && next.protocol === "http:")) {
            this.emit("violation", `refused cross-origin/downgrade redirect to ${next.origin}`);
            return {
              kind: "final",
              end: {
                kind: "failure",
                failure: { kind: "forbidden", message: `cross-origin redirect refused: ${next.origin}`, status },
                delivery: "not-sent",
              },
            };
          }
          redirects += 1;
          currentUrl = next.toString();
          continue;
        }
        break;
      }
      if (!response) throw new Error("no response");
      return await this.handleResponse(response, {
        isRequest,
        method,
        expectedId,
        wireId: isRequest ? (wireMsg as JsonRpcRequest).id : undefined,
        ctx,
        notifications,
        controller,
        timedOut: () => timedOut,
        armIdle,
      });
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      ctx.signal.removeEventListener("abort", onCallerAbort);
      this.inFlight.delete(controller);
    }
  }

  private async handleResponse(
    response: Response,
    args: {
      isRequest: boolean;
      method: string;
      expectedId: JsonRpcRequest["id"] | undefined;
      wireId: JsonRpcRequest["id"] | undefined;
      ctx: TransportCall;
      notifications: NotificationQueue;
      controller: AbortController;
      timedOut: () => boolean;
      armIdle: () => void;
    },
  ): Promise<AttemptOutcome> {
    const { isRequest, method, expectedId } = args;
    const status = response.status;
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    // Auth challenges (AUTH-HTTP-1/2): 401 always; 403 only with insufficient_scope.
    const wwwAuth = response.headers.get("www-authenticate") ?? undefined;
    const insufficientScope = wwwAuth?.toLowerCase().includes("insufficient_scope") ?? false;
    if (status === 401 || (status === 403 && insufficientScope)) {
      await response.body?.cancel().catch(() => undefined);
      if (this.authProvider?.onChallenge) {
        let retry = false;
        try {
          retry = await this.authProvider.onChallenge(
            { status: status as 401 | 403, ...(wwwAuth ? { wwwAuthenticate: wwwAuth } : {}), resource: this.url, operation: method },
            args.controller.signal,
          );
        } catch {
          retry = false;
        }
        if (retry) return { kind: "auth-retry" };
      }
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "forbidden", message: `HTTP ${status} auth challenge not resolved`, status },
          delivery: "not-sent",
        },
      };
    }
    if (status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: "final",
        end: { kind: "failure", failure: { kind: "forbidden", message: "HTTP 403 forbidden", status }, delivery: "not-sent" },
      };
    }
    if (status === 413 || status === 431) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "too-large", message: `HTTP ${status}: request headers/body too large (not executed)`, status },
          delivery: "not-sent",
        },
      };
    }
    if (status === 429 || status === 408 || status >= 500) {
      const retryAfter = response.headers.get("retry-after") ?? undefined;
      if (retryAfter) this.lastRetryAfter = retryAfter;
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: {
            kind: "http-status",
            message: `HTTP ${status}${retryAfter ? ` Retry-After: ${retryAfter}` : ""}`,
            status,
          },
          // Server may have run the call: core turns this into uncertain-write for non-idempotent (§7.4/7.7).
          delivery: "delivered-no-response",
        },
      };
    }

    if (!isRequest) {
      // Notification POST: 202 expected; any other 2xx tolerated+logged; rest is rejection.
      await response.body?.cancel().catch(() => undefined);
      if (status === 202) return { kind: "final", end: { kind: "response", message: emptyNotificationAck(expectedId) } };
      if (status >= 200 && status < 300) {
        this.emit("lifecycle", `notification POST answered ${status} (tolerated, expected 202)`);
        return { kind: "final", end: { kind: "response", message: emptyNotificationAck(expectedId) } };
      }
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "http-status", message: `notification rejected with HTTP ${status}`, status },
          delivery: "not-sent",
        },
      };
    }

    if (status === 202) {
      await response.body?.cancel().catch(() => undefined);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "http-status", message: "unexpected 202 for a request", status },
          delivery: "delivered-no-response",
        },
      };
    }

    if (status >= 200 && status < 300 && contentType.includes("text/event-stream")) {
      return this.handleSse(response, args);
    }

    // JSON (or error-status) bodies.
    let text: string;
    try {
      text = await this.readBodyText(response, this.maxJsonBytes);
    } catch (err) {
      if (err instanceof TooLargeError) {
        return {
          kind: "final",
          end: { kind: "failure", failure: { kind: "too-large", message: err.message }, delivery: "delivered-no-response" },
        };
      }
      if (args.ctx.signal.aborted || args.controller.signal.aborted) {
        return {
          kind: "final",
          end: {
            kind: "failure",
            failure: { kind: args.timedOut() ? "timeout" : "closed", message: "aborted while reading body", cause: err },
            delivery: "delivered-no-response",
          },
        };
      }
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "stream-broken", message: `truncated-json: ${err instanceof Error ? err.message : String(err)}`, cause: err },
          delivery: "delivered-no-response",
        },
      };
    }

    if (status >= 200 && status < 300) {
      if (!contentType.includes("application/json") && !contentType.includes("+json")) {
        this.emit("violation", `unexpected content-type '${contentType}' on 2xx`);
        return {
          kind: "final",
          end: {
            kind: "failure",
            failure: { kind: "stream-broken", message: `protocol-violation: unexpected content-type '${contentType}'` },
            delivery: "delivered-no-response",
          },
        };
      }
      if (text.trim() === "") {
        this.emit("violation", "HTTP 200 with empty body for a request (EDGE-21)");
        return {
          kind: "final",
          end: {
            kind: "failure",
            failure: { kind: "stream-broken", message: "protocol-violation: empty 200 body" },
            delivery: "delivered-no-response",
          },
        };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const legacy = status === 400 ? "legacy-or-malformed" : status === 404 || status === 405 ? "legacy-or-wrong-endpoint" : "malformed-body";
      this.emit("violation", `${legacy}: HTTP ${status} with non-JSON body`);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "http-status", message: `${legacy}: HTTP ${status} body is not a JSON-RPC message`, status },
          delivery: status >= 400 ? "not-sent" : "delivered-no-response",
        },
      };
    }
    if (Array.isArray(parsed)) {
      this.emit("violation", "JSON-RPC batch array rejected (HTTP-REQ-2)");
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "stream-broken", message: "protocol-violation: JSON-RPC batch array" },
          delivery: "delivered-no-response",
        },
      };
    }
    const inbound = parseInboundMessage(parsed);
    if ("error" in inbound || (inbound.kind !== "response" && inbound.kind !== "error")) {
      const legacy = status === 400 ? "legacy-or-malformed" : status === 404 || status === 405 ? "legacy-or-wrong-endpoint" : "protocol-violation";
      this.emit("violation", `${legacy}: HTTP ${status} body is not a JSON-RPC response`);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "http-status", message: `${legacy}: HTTP ${status}`, status },
          delivery: status >= 400 ? "not-sent" : "delivered-no-response",
        },
      };
    }
    const message = this.normalizeResponseId(inbound.message as JsonRpcResponse | JsonRpcErrorResponse, args.wireId, expectedId);
    if (expectedId !== undefined && "id" in message && message.id !== expectedId) {
      this.emit("violation", `response id mismatch: expected ${String(expectedId)}, got ${String(message.id)}`);
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "stream-broken", message: "protocol-violation: response id does not equal request id" },
          delivery: "delivered-no-response",
        },
      };
    }
    if ("error" in message && message.error.code === -32020 && status === 400) {
      return { kind: "header-mismatch", message };
    }
    if (status >= 400 && !("error" in message)) {
      return {
        kind: "final",
        end: {
          kind: "failure",
          failure: { kind: "http-status", message: `HTTP ${status}`, status },
          delivery: "not-sent",
        },
      };
    }
    if (method === "tools/list" && !("error" in message)) {
      this.processToolsList(message as JsonRpcResponse);
    }
    return { kind: "final", end: { kind: "response", message } };
  }

  private async handleSse(
    response: Response,
    args: {
      method: string;
      expectedId: JsonRpcRequest["id"] | undefined;
      wireId: JsonRpcRequest["id"] | undefined;
      ctx: TransportCall;
      notifications: NotificationQueue;
      controller: AbortController;
      timedOut: () => boolean;
      armIdle: () => void;
    },
  ): Promise<AttemptOutcome> {
    const { method, expectedId, notifications } = args;
    if (!response.body) {
      return {
        kind: "final",
        end: { kind: "failure", failure: { kind: "stream-broken", message: "SSE response has no body" }, delivery: "delivered-no-response" },
      };
    }
    const reader = response.body.getReader();
    const parser = new SseParser(this.maxSseEventBytes);
    let totalBytes = 0;
    let finalMessage: JsonRpcResponse | JsonRpcErrorResponse | undefined;
    const fail = (failure: TransportFailure, delivery: ExchangeEnd & { kind: "failure" } extends never ? never : "delivered-no-response" | "maybe-delivered"): AttemptOutcome => ({
      kind: "final",
      end: { kind: "failure", failure, delivery },
    });
    args.armIdle();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (finalMessage) break;
          if (args.ctx.signal.aborted || args.controller.signal.aborted) {
            return fail(
              { kind: args.timedOut() ? "timeout" : "closed", message: "stream aborted", cause: err },
              "delivered-no-response",
            );
          }
          return fail({ kind: "stream-broken", message: `SSE stream broke: ${err instanceof Error ? err.message : String(err)}`, cause: err }, "delivered-no-response");
        }
        if (chunk.done) break;
        args.armIdle();
        totalBytes += chunk.value.byteLength;
        if (totalBytes > this.maxSseStreamBytes) {
          await reader.cancel().catch(() => undefined);
          return fail({ kind: "too-large", message: `SSE stream exceeds ${this.maxSseStreamBytes} bytes` }, "delivered-no-response");
        }
        let events;
        try {
          events = parser.push(chunk.value);
        } catch (err) {
          await reader.cancel().catch(() => undefined);
          return fail({ kind: "too-large", message: err instanceof Error ? err.message : String(err), cause: err }, "delivered-no-response");
        }
        for (const ev of events) {
          if (ev.event !== "" && ev.event !== "message") {
            this.emit("violation", `ignored non-message SSE event '${ev.event}' (HTTP-SSE-2)`);
            continue;
          }
          // ev.id / ev.retry are parsed and deliberately discarded (HTTP-SSE-3).
          let payload: unknown;
          try {
            payload = JSON.parse(ev.data);
          } catch {
            this.emit("violation", "SSE data is not valid JSON (EDGE-20); event dropped");
            continue;
          }
          if (Array.isArray(payload)) {
            this.emit("violation", "JSON-RPC batch on SSE stream rejected");
            continue;
          }
          const inbound = parseInboundMessage(payload);
          if ("error" in inbound) {
            this.emit("violation", `invalid JSON-RPC message on SSE stream: ${inbound.error}`);
            continue;
          }
          if (inbound.kind === "server-request") {
            await reader.cancel().catch(() => undefined);
            this.emit("violation", "server sent an independent JSON-RPC request on the SSE stream (HTTP-SSE-4)");
            return fail({ kind: "stream-broken", message: "protocol-violation: request on SSE stream" }, "delivered-no-response");
          }
          if (inbound.kind === "notification") {
            const notif = inbound.message as JsonRpcNotification;
            if (!this.isRelatedNotification(notif, args, method)) {
              notifications.droppedUnrelated += 1;
              this.emit("violation", `dropped unrelated SSE notification '${notif.method}' (HTTP-SSE-5)`);
              continue;
            }
            notifications.push(notif);
            continue;
          }
          const message = this.normalizeResponseId(inbound.message as JsonRpcResponse | JsonRpcErrorResponse, args.wireId, expectedId);
          if (expectedId !== undefined && message.id !== expectedId) {
            this.emit("violation", `dropped SSE response with mismatched id ${String(message.id)}`);
            continue;
          }
          if (finalMessage) {
            this.emit("violation", "second response for same id on SSE stream (HTTP-SSE-7)");
            continue;
          }
          finalMessage = message;
          // Final response should terminate the stream: cancel body, ignore later events (HTTP-SSE-6).
          await reader.cancel().catch(() => undefined);
          if (method === "tools/list" && !("error" in finalMessage)) this.processToolsList(finalMessage as JsonRpcResponse);
          if ("error" in finalMessage && finalMessage.error.code === -32020) {
            return { kind: "header-mismatch", message: finalMessage };
          }
          return { kind: "final", end: { kind: "response", message: finalMessage } };
        }
      }
    } finally {
      try {
        parser.end();
      } catch {
        /* ignore flush errors after settle */
      }
      await reader.cancel().catch(() => undefined);
    }
    if (finalMessage) return { kind: "final", end: { kind: "response", message: finalMessage } };
    if (args.ctx.signal.aborted || args.controller.signal.aborted) {
      return fail({ kind: args.timedOut() ? "timeout" : "closed", message: "request aborted" }, "delivered-no-response");
    }
    this.emit("violation", "SSE stream ended without a final response");
    return fail({ kind: "stream-broken", message: "stream-ended-without-response" }, "delivered-no-response");
  }

  private isRelatedNotification(
    notif: JsonRpcNotification,
    args: { expectedId: JsonRpcRequest["id"] | undefined; wireId: JsonRpcRequest["id"] | undefined },
    method: string,
  ): boolean {
    const params = isRecord(notif.params) ? notif.params : {};
    if (notif.method === "notifications/progress") {
      if (method === "subscriptions/listen") return false; // HTTP-SSE-8
      const token = params["progressToken"];
      // RequestManager sets progressToken to the request id; accept wire/original id too.
      if (token === args.expectedId || token === args.wireId) return true;
      return args.expectedId === undefined && token !== undefined;
    }
    const meta = isRecord(params["_meta"]) ? params["_meta"] : undefined;
    const subId = meta?.[META_SUBSCRIPTION_ID] ?? params["subscriptionId"];
    if (typeof subId === "string") {
      // Accept only when it matches a token/id we know; otherwise still accept on listen streams carrying any sub id.
      return method === "subscriptions/listen" || typeof params["subscriptionId"] === "string";
    }
    // Non-progress notifications without routing keys are treated as related to this request-scoped stream.
    return true;
  }

  private normalizeResponseId(
    message: JsonRpcResponse | JsonRpcErrorResponse,
    wireId: JsonRpcRequest["id"] | undefined,
    expectedId: JsonRpcRequest["id"] | undefined,
  ): JsonRpcResponse | JsonRpcErrorResponse {
    if (wireId !== undefined && expectedId !== undefined && wireId !== expectedId && message.id === wireId) {
      return { ...message, id: expectedId };
    }
    return message;
  }

  private processToolsList(message: JsonRpcResponse): void {
    const result = message.result;
    if (!isRecord(result) || !Array.isArray(result["tools"])) return;
    const kept: unknown[] = [];
    for (const tool of result["tools"] as unknown[]) {
      if (!isRecord(tool)) {
        kept.push(tool);
        continue;
      }
      const name = typeof tool["name"] === "string" ? tool["name"] : "(unnamed)";
      const validation = validateXmcpHeaderSchema(tool["inputSchema"]);
      if (!validation.valid) {
        for (const v of validation.violations) {
          this.emit("violation", `x-mcp-header: tool '${name}' excluded: ${v}`);
          this.logger?.warn("x-mcp-header tool excluded", { tool: name, violation: v });
        }
        continue; // HTTP-PARAM-2
      }
      kept.push(tool);
      if (typeof tool["name"] === "string") this.toolParams.set(tool["name"], validation.params);
    }
    (result as Record<string, unknown>)["tools"] = kept;
  }

  private async buildHeaders(
    wireMsg: JsonRpcRequest | JsonRpcNotification,
    ctx: TransportCall,
  ): Promise<Headers> {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    const params = isRecord(wireMsg.params) ? wireMsg.params : {};
    const meta = isRecord(params["_meta"]) ? params["_meta"] : {};
    const version =
      typeof meta[META_PROTOCOL_VERSION] === "string"
        ? (meta[META_PROTOCOL_VERSION] as string)
        : (this.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION);
    headers.set("MCP-Protocol-Version", version);
    headers.set("Mcp-Method", wireMsg.method);
    // Mcp-Name (HTTP-HDR-3)
    let name: string | undefined;
    if ("id" in wireMsg) {
      if (ctx.headersHint?.name) name = ctx.headersHint.name;
      else if ((wireMsg.method === "tools/call" || wireMsg.method === "prompts/get") && typeof params["name"] === "string") name = params["name"] as string;
      else if (wireMsg.method === "resources/read" && typeof params["uri"] === "string") name = params["uri"] as string;
    }
    if (name !== undefined) headers.set("Mcp-Name", encodeHeaderValue(name));
    // Mcp-Param-* mirroring (HTTP-PARAM-4/5)
    if ("id" in wireMsg && wireMsg.method === "tools/call") {
      const toolName = typeof params["name"] === "string" ? (params["name"] as string) : undefined;
      const annotated = toolName ? this.toolParams.get(toolName) : undefined;
      if (annotated) {
        const args = isRecord(params["arguments"]) ? params["arguments"] : params;
        for (const p of annotated) {
          const value = extractAtPath(args, p.path);
          if (value === undefined || value === null) continue;
          if (p.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
            this.emit("violation", `Mcp-Param-${p.headerName} omitted: integer value out of safe range or not an integer`);
            continue;
          }
          if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            headers.set(`Mcp-Param-${p.headerName}`, encodeHeaderValue(value));
          }
        }
      }
    }
    if ("id" in wireMsg && ctx.headersHint?.params) {
      for (const [k, v] of Object.entries(ctx.headersHint.params)) {
        headers.set(`Mcp-Param-${k}`, encodeHeaderValue(v));
      }
    }
    for (const [k, v] of Object.entries(this.extraHeaders)) {
      if (FORBIDDEN_OUTBOUND.has(k.toLowerCase())) {
        this.emit("violation", `refused forbidden outbound header '${k}'`);
        continue;
      }
      headers.set(k, v);
    }
    // AuthProvider interceptor hook (core auth-types; no auth implementation here).
    if (this.authProvider) {
      try {
        const auth = await this.authProvider.headerFor(this.url, wireMsg.method);
        if (auth?.authorization) headers.set("Authorization", auth.authorization);
      } catch (err) {
        this.emit("violation", `auth headerFor failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Hard guarantee for the wire scan: these are never emitted.
    headers.delete("Mcp-Session-Id");
    headers.delete("Last-Event-ID");
    return headers;
  }

  private async readBodyText(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new TooLargeError(maxBytes);
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TooLargeError(maxBytes);
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  private emit(kind: TransportDiagnostic["kind"], message: string): void {
    this.diag.emit({ kind, message, atMs: this.clock.now() });
  }
}

class TooLargeError extends Error {
  constructor(max: number) {
    super(`response body exceeds ${max} bytes (HTTP-LIMIT-1)`);
    this.name = "TooLargeError";
  }
}

function emptyNotificationAck(id: JsonRpcRequest["id"] | undefined): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? 0, result: { resultType: "complete" } };
}
