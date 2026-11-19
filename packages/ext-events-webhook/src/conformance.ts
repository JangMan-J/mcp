import { isDeepStrictEqual } from "node:util";
import {
  BoundedEventSink,
  bindListener,
  createWebhookHandler,
  signWebhook,
  type ControlSignal,
  type EventOccurrence,
  type EventSink,
  type RawWebhookRequest,
  type WebhookHttpResponse,
} from "./index.js";

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const MUTANTS = new Set([
  "skip-signature-check",
  "reserialize-body",
  "accept-non-v1",
  "first-signature-only",
  "first-secret-only",
  "skip-timestamp-check",
  "echo-unverified-challenge",
  "queue-challenge-as-event",
  "control-as-event",
  "drop-control-signals",
  "no-dedupe",
  "interpolate-data",
  "allow-http-callback",
]);

export const supportsMutant = (name: string): boolean => MUTANTS.has(name);

type Json = Record<string, unknown>;
const bad = (m: string): never => { throw new Error(`malformed fixture: ${m}`); };
const mismatch = (m: string): never => { throw new ObservationMismatch(m); };
const eq = (a: unknown, e: unknown, label: string): void => {
  if (!isDeepStrictEqual(a, e)) mismatch(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};
const str = (v: unknown, m: string): string => (typeof v === "string" ? v : bad(m));

/** Sink wrapper that injects mutant faults and records what was observed. */
class ObservedSink implements EventSink {
  constructor(private readonly inner: BoundedEventSink, private readonly mutant: string | undefined) {}
  private readonly raw: EventOccurrence[] = [];
  append(ev: EventOccurrence): boolean {
    const e = this.mutant === "interpolate-data" ? { ...ev, data: `event: ${JSON.stringify(ev.data)}` } : ev;
    if (this.mutant === "no-dedupe") { this.raw.push(e); return true; }
    return this.inner.append(e);
  }
  control(signal: ControlSignal): void {
    if (this.mutant === "drop-control-signals") return;
    if (this.mutant === "control-as-event") {
      this.append({ subscriptionId: signal.subscriptionId, eventId: `control:${signal.kind}`, data: signal });
      return;
    }
    this.inner.control(signal);
  }
  events(): readonly EventOccurrence[] { return this.mutant === "no-dedupe" ? this.raw : this.inner.events(); }
  controls(): readonly ControlSignal[] { return this.inner.controls(); }
}

export async function runExchange(fixture: unknown, mutant?: string): Promise<{ frames: Array<Record<string, unknown>>; zeroWire?: true }> {
  const frames: Array<Record<string, unknown>> = [];
  if (mutant !== undefined && !MUTANTS.has(mutant)) throw new Error(`unknown mutant: ${mutant}`);
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) bad("fixture must be object");
  const fx = fixture as Json;
  const script = Array.isArray(fx["script"]) ? (fx["script"] as Json[]) : bad("script");
  const client = (fx["client"] as Json | undefined) ?? {};
  const setup = (client["setup"] as Json | undefined) ?? {};
  const allSecrets = Array.isArray(setup["secrets"]) ? (setup["secrets"] as unknown[]).map((s) => str(s, "secret")) : bad("setup.secrets");
  const nowSec = typeof setup["nowSec"] === "number" ? setup["nowSec"] : bad("setup.nowSec");
  const expectObj = (fx["expect"] as Json | undefined) ?? {};
  const outcomeExpect = (expectObj["outcome"] as Json | undefined) ?? {};

  const secrets = mutant === "first-secret-only" ? allSecrets.slice(0, 1) : allSecrets;
  const sink = new ObservedSink(new BoundedEventSink({ capacity: 64 }), mutant);
  const outcomes: Record<string, unknown> = {};

  for (const step of script) {
    const as = str(step["as"], "step.as");
    if (step["do"] === "listen") {
      const callbackUrl = str(step["callbackUrl"], "listen.callbackUrl");
      let closed = false;
      const port = { start: async () => ({ callbackUrl, close: async () => { closed = true; } }) };
      if (mutant === "allow-http-callback") { outcomes[as] = { listening: true }; continue; }
      try {
        await bindListener(port, async () => ({ status: 500, headers: {}, body: "" }));
        outcomes[as] = { listening: true };
      } catch (e) {
        outcomes[as] = { listening: false, error: (e as Error).name, closed };
      }
      continue;
    }
    if (step["do"] !== "deliver") bad(`unknown step ${String(step["do"])}`);
    const webhookId = str(step["webhookId"], "deliver.webhookId");
    const ts = String(typeof step["timestamp"] === "number" ? step["timestamp"] : bad("deliver.timestamp"));
    const bodyText = str(step["rawBody"], "deliver.rawBody");
    const signed = Buffer.from(bodyText, "utf8");
    const sent = typeof step["tamperedBody"] === "string" ? Buffer.from(step["tamperedBody"], "utf8") : signed;
    const tokens: string[] = [];
    for (const s of (Array.isArray(step["signWith"]) ? step["signWith"] : bad("deliver.signWith")) as Json[]) {
      const tok = signWebhook(str(s["secret"], "signWith.secret"), webhookId, ts, signed);
      tokens.push(typeof s["version"] === "string" ? tok.replace(/^v1,/, `${s["version"]},`) : tok);
    }
    let sigHeader = tokens.join(" ");
    let rawBody: Uint8Array = sent;
    if (mutant === "reserialize-body") rawBody = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(sent).toString("utf8"))), "utf8");
    if (mutant === "accept-non-v1") sigHeader = sigHeader.replace(/(^| )v\d+,/g, "$1v1,");
    if (mutant === "first-signature-only") sigHeader = sigHeader.split(" ")[0] ?? "";
    if (mutant === "skip-signature-check") sigHeader = signWebhook(allSecrets[0]!, webhookId, ts, rawBody);
    const headers: Record<string, string | undefined> = {
      "webhook-id": webhookId,
      "webhook-timestamp": ts,
      "webhook-signature": sigHeader,
      ...(typeof step["subscriptionId"] === "string" ? { "x-mcp-subscription-id": step["subscriptionId"] } : {}),
    };
    const clockSec = mutant === "skip-timestamp-check" ? Number(ts) : nowSec;
    const clock = { now: () => clockSec * 1000, setTimeout: () => () => {} };
    const handler = createWebhookHandler({ secrets, clock, sink });
    const req: RawWebhookRequest = { headers, rawBody };
    let message: unknown;
    try { message = JSON.parse(Buffer.from(rawBody).toString("utf8")); } catch { message = Buffer.from(rawBody).toString("utf8"); }
    frames.push({ direction: "server", endpoint: "other", method: "POST", headers, message });
    let res: WebhookHttpResponse = await handler(req);
    const parsedBody = (() => { try { return JSON.parse(bodyText) as Json; } catch { return {}; } })();
    if (mutant === "echo-unverified-challenge" && res.status === 401 && parsedBody["type"] === "verification") {
      res = { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ challenge: parsedBody["challenge"] }) };
    }
    if (mutant === "queue-challenge-as-event" && res.status === 200 && parsedBody["type"] === "verification") {
      sink.append({ subscriptionId: "", eventId: "verification", data: parsedBody });
    }
    frames.push({ direction: "server", endpoint: "other", headers: res.headers, message: JSON.parse(res.body) as unknown });
    outcomes[as] = { status: res.status, body: JSON.parse(res.body) as unknown };
  }

  for (const [as, exp] of Object.entries(outcomeExpect)) eq(outcomes[as], exp, `outcome ${as}`);
  if ("events" in expectObj) eq(sink.events().map((e) => ({ ...e })), expectObj["events"], "events");
  if ("controls" in expectObj) eq(sink.controls().map((c) => ({ ...c })), expectObj["controls"], "controls");
  return frames.length ? { frames } : { frames, zeroWire: true };
}
