import { createHmac, timingSafeEqual } from "node:crypto";
import { systemClock, type Clock } from "@mcp-client/core";

export const EVENTS_WEBHOOK_ID = "io.modelcontextprotocol/events-webhook";
export const stage = "draft" as const;
export const defaultEnabled = false as const;
export const MAX_TIMESTAMP_AGE_MS = 300_000;
export const EVENTS_WEBHOOK_PIN = {
  commit: "4165cc2e580afa795842002f631edbbe17c63757",
  prHead: "60b15c16f2e7265ea34ac51099dc5be62f734692",
} as const;

// ---- Listener port (EXT-events-18, EXT-events-25) ----

export interface RawWebhookRequest {
  readonly headers: Record<string, string | undefined>;
  readonly rawBody: Uint8Array;
}
export interface WebhookHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}
export type WebhookRequestHandler = (req: RawWebhookRequest) => Promise<WebhookHttpResponse>;
export interface ListenerBinding {
  readonly callbackUrl: string;
  close(): Promise<void>;
}
/** Host-owned inbound HTTP listener. Bind address, port, and TLS are host decisions. */
export interface ListenerPort {
  start(handler: WebhookRequestHandler): Promise<ListenerBinding>;
}

export class InsecureCallbackUrlError extends Error {
  constructor(url: string) {
    super(`webhook callback URL must use https: ${url.slice(0, 8)}...`);
    this.name = "InsecureCallbackUrlError";
  }
}

export function isHttpsCallbackUrl(url: string): boolean {
  return typeof url === "string" && url.startsWith("https://");
}

/** Start the host listener and refuse any non-https callback URL. */
export async function bindListener(port: ListenerPort, handler: WebhookRequestHandler): Promise<ListenerBinding> {
  const binding = await port.start(handler);
  if (!isHttpsCallbackUrl(binding.callbackUrl)) {
    await binding.close();
    throw new InsecureCallbackUrlError(binding.callbackUrl);
  }
  return binding;
}

// ---- Event sink / source (EXT-events-12, -24, -27, -30) ----

export interface EventOccurrence {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly name?: string;
  readonly timestamp?: string;
  readonly cursor?: string | null;
  /** Untrusted payload, stored verbatim. Never executed or interpolated. */
  readonly data: unknown;
}
export type ControlSignal =
  | { readonly kind: "gap"; readonly subscriptionId: string; readonly truncated: true; readonly cursor?: string | null }
  | { readonly kind: "terminated"; readonly subscriptionId: string; readonly reason?: string };

export interface EventSink {
  /** Returns false when the occurrence was a duplicate and dropped. */
  append(ev: EventOccurrence): boolean;
  control(signal: ControlSignal): void;
}
export interface EventSource {
  events(): readonly EventOccurrence[];
  controls(): readonly ControlSignal[];
  drain(): EventOccurrence[];
}

export interface BoundedEventSinkOptions {
  readonly capacity?: number;
  readonly dedupeWindow?: number;
}

export class BoundedEventSink implements EventSink, EventSource {
  private readonly capacity: number;
  private readonly dedupeWindow: number;
  private readonly queue: EventOccurrence[] = [];
  private readonly signals: ControlSignal[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(opts: BoundedEventSinkOptions = {}) {
    this.capacity = Math.max(1, opts.capacity ?? 1000);
    this.dedupeWindow = Math.max(this.capacity, opts.dedupeWindow ?? this.capacity * 4);
  }

  append(ev: EventOccurrence): boolean {
    const key = JSON.stringify([ev.subscriptionId, ev.eventId]);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > this.dedupeWindow) this.seen.delete(this.seenOrder.shift()!);
    this.queue.push(Object.freeze({ ...ev }));
    if (this.queue.length > this.capacity) {
      const dropped = this.queue.shift()!;
      this.signals.push({ kind: "gap", subscriptionId: dropped.subscriptionId, truncated: true });
    }
    return true;
  }
  control(signal: ControlSignal): void {
    this.signals.push(Object.freeze({ ...signal }));
  }
  events(): readonly EventOccurrence[] {
    return [...this.queue];
  }
  controls(): readonly ControlSignal[] {
    return [...this.signals];
  }
  drain(): EventOccurrence[] {
    return this.queue.splice(0, this.queue.length);
  }
}

// ---- Standard Webhooks verification (EXT-events-20..22) ----

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface VerifyOptions {
  readonly secrets: readonly string[];
  readonly clock?: Clock;
  readonly maxAgeMs?: number;
}

const header = (h: Record<string, string | undefined>, name: string): string | undefined => {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return v;
  return undefined;
};

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
function strictBase64(s: string): Buffer | undefined {
  if (s.length === 0 || s.length % 4 !== 0 || !B64.test(s)) return undefined;
  return Buffer.from(s, "base64");
}

export function secretKey(secret: string): Buffer | undefined {
  if (!secret.startsWith("whsec_")) return undefined;
  const key = strictBase64(secret.slice("whsec_".length));
  return key && key.length > 0 ? key : undefined;
}

export function signedPayload(webhookId: string, webhookTimestamp: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${webhookId}.${webhookTimestamp}.`, "utf8"), Buffer.from(rawBody)]);
}

/** Produce a `v1,<base64>` token. Used by tests and fixtures. */
export function signWebhook(secret: string, webhookId: string, webhookTimestamp: string, rawBody: Uint8Array): string {
  const key = secretKey(secret);
  if (!key) throw new Error("invalid whsec_ secret");
  return `v1,${createHmac("sha256", key).update(signedPayload(webhookId, webhookTimestamp, rawBody)).digest("base64")}`;
}

export function verifyWebhook(req: RawWebhookRequest, opts: VerifyOptions): VerifyResult {
  const id = header(req.headers, "webhook-id");
  const ts = header(req.headers, "webhook-timestamp");
  const sig = header(req.headers, "webhook-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing-headers" };
  if (!/^\d+$/.test(ts)) return { ok: false, reason: "bad-timestamp" };
  const nowSec = Math.floor((opts.clock ?? systemClock).now() / 1000);
  const maxAgeSec = Math.floor((opts.maxAgeMs ?? MAX_TIMESTAMP_AGE_MS) / 1000);
  if (Math.abs(nowSec - Number(ts)) > maxAgeSec) return { ok: false, reason: "stale-timestamp" };
  const payload = signedPayload(id, ts, req.rawBody);
  const keys = opts.secrets.map(secretKey).filter((k): k is Buffer => k !== undefined);
  const digests = keys.map((k) => createHmac("sha256", k).update(payload).digest());
  for (const token of sig.split(" ")) {
    if (!token.startsWith("v1,")) continue;
    const got = strictBase64(token.slice(3));
    if (!got) continue;
    for (const d of digests) if (got.length === d.length && timingSafeEqual(got, d)) return { ok: true };
  }
  return { ok: false, reason: "invalid-signature" };
}

// ---- Handler (EXT-events-20, -23, -24, -27, -30) ----

export interface WebhookHandlerOptions extends VerifyOptions {
  readonly sink: EventSink;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;
const respond = (status: number, body: unknown): WebhookHttpResponse => ({ status, headers: { ...JSON_HEADERS }, body: JSON.stringify(body) });
export const INVALID_SIGNATURE: WebhookHttpResponse = { status: 401, headers: { ...JSON_HEADERS }, body: '{"error":"invalid-signature"}' };

export function createWebhookHandler(opts: WebhookHandlerOptions): WebhookRequestHandler {
  return async (req) => {
    if (!verifyWebhook(req, opts).ok) return { ...INVALID_SIGNATURE, headers: { ...JSON_HEADERS } };
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(req.rawBody).toString("utf8"));
    } catch {
      return respond(400, { error: "invalid-json" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return respond(400, { error: "invalid-envelope" });
    const env = body as Record<string, unknown>;
    if (env["type"] === "verification" && typeof env["challenge"] === "string") {
      return respond(200, { challenge: env["challenge"] });
    }
    const subHeader = header(req.headers, "x-mcp-subscription-id");
    const subscriptionId = typeof subHeader === "string" && subHeader ? subHeader
      : typeof env["subscriptionId"] === "string" ? env["subscriptionId"] : "";
    if (env["type"] === "gap") {
      const cursor = typeof env["cursor"] === "string" ? env["cursor"] : null;
      opts.sink.control({ kind: "gap", subscriptionId, truncated: true, cursor });
      return respond(200, {});
    }
    if (env["type"] === "terminated") {
      const reason = typeof env["reason"] === "string" ? env["reason"] : undefined;
      opts.sink.control({ kind: "terminated", subscriptionId, ...(reason !== undefined ? { reason } : {}) });
      return respond(200, {});
    }
    const eventId = env["eventId"];
    if (typeof eventId !== "string" || !eventId) return respond(400, { error: "invalid-envelope" });
    opts.sink.append({
      subscriptionId,
      eventId,
      ...(typeof env["name"] === "string" ? { name: env["name"] } : {}),
      ...(typeof env["timestamp"] === "string" ? { timestamp: env["timestamp"] } : {}),
      ...("cursor" in env ? { cursor: typeof env["cursor"] === "string" ? env["cursor"] : null } : {}),
      data: env["data"],
    });
    return respond(200, {});
  };
}
