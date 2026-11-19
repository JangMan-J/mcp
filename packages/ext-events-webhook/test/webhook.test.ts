import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BoundedEventSink,
  EVENTS_WEBHOOK_ID,
  InsecureCallbackUrlError,
  bindListener,
  createWebhookHandler,
  defaultEnabled,
  signWebhook,
  stage,
  verifyWebhook,
  type RawWebhookRequest,
} from "../src/index.js";
import { ObservationMismatch, runExchange, supportsMutant } from "../src/conformance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../../fixtures/exchanges/ext/events/webhook");
const S1 = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const S2 = "whsec_cm90YXRlZC1zZWNyZXQta2V5LTAxMjM0NTY3ODlhYg==";
const SX = "whsec_dW5jb25maWd1cmVkLWtleS0wMDAwMDA=";
const NOW = 1_700_000_000;
const clock = { now: () => NOW * 1000, setTimeout: () => () => {} };

function req(body: string, sig: string, ts = String(NOW), id = "msg_1", sub = "sub-1"): RawWebhookRequest {
  return {
    headers: { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig, "x-mcp-subscription-id": sub },
    rawBody: Buffer.from(body, "utf8"),
  };
}
const sign = (secret: string, body: string, ts = String(NOW), id = "msg_1") => signWebhook(secret, id, ts, Buffer.from(body, "utf8"));

describe("@mcp-client/ext-events-webhook", () => {
  it("is draft, off by default, with no side effects", () => {
    expect(EVENTS_WEBHOOK_ID).toBe("io.modelcontextprotocol/events-webhook");
    expect(stage).toBe("draft");
    expect(defaultEnabled).toBe(false);
    const pkg = JSON.parse(readFileSync(join(HERE, "../package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toEqual(["@mcp-client/core"]);
    const readme = readFileSync(join(HERE, "../README.md"), "utf8");
    expect(readme).toContain("Stage: draft — OFF BY DEFAULT; explicit second opt-in required");
    expect(readme).toContain("does\nnot provide or claim exactly-once");
  });

  it("verifies HMAC over whitespace-preserved raw bytes; tampered byte fails", () => {
    const body = '{ "eventId" : "e1",\n  "data": {"a": 1} }';
    const sig = sign(S1, body);
    expect(verifyWebhook(req(body, sig), { secrets: [S1], clock }).ok).toBe(true);
    const compact = JSON.stringify(JSON.parse(body));
    expect(verifyWebhook(req(compact, sig), { secrets: [S1], clock }).ok).toBe(false);
    const tampered = body.replace('"a": 1', '"a": 2');
    expect(verifyWebhook(req(tampered, sig), { secrets: [S1], clock }).ok).toBe(false);
  });

  it("rejects non-v1 signatures and accepts any of several space-delimited tokens (rotation)", () => {
    const body = '{"eventId":"e1","data":1}';
    expect(verifyWebhook(req(body, sign(S1, body).replace(/^v1,/, "v1a,")), { secrets: [S1], clock }).ok).toBe(false);
    expect(verifyWebhook(req(body, sign(S1, body).replace(/^v1,/, "v2,")), { secrets: [S1], clock }).ok).toBe(false);
    const multi = `${sign(SX, body)} ${sign(S2, body)}`;
    expect(verifyWebhook(req(body, multi), { secrets: [S1, S2], clock }).ok).toBe(true);
    expect(verifyWebhook(req(body, multi), { secrets: [S1], clock }).ok).toBe(false);
  });

  it("rejects timestamps more than 5 minutes off and malformed timestamps", () => {
    const body = '{"eventId":"e1","data":1}';
    const old = String(NOW - 301);
    expect(verifyWebhook(req(body, sign(S1, body, old), old), { secrets: [S1], clock }).ok).toBe(false);
    const edge = String(NOW - 300);
    expect(verifyWebhook(req(body, sign(S1, body, edge), edge), { secrets: [S1], clock }).ok).toBe(true);
    const bad = `${NOW}.5`;
    expect(verifyWebhook(req(body, sign(S1, body, bad), bad), { secrets: [S1], clock }).ok).toBe(false);
  });

  it("echoes only verified challenges and never queues them as events", async () => {
    const sink = new BoundedEventSink();
    const handler = createWebhookHandler({ secrets: [S1], clock, sink });
    const body = '{"type":"verification","challenge":"c-1"}';
    const unverified = await handler(req(body, sign(SX, body)));
    expect(unverified.status).toBe(401);
    expect(unverified.body).toBe('{"error":"invalid-signature"}');
    const ok = await handler(req(body, sign(S1, body)));
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ challenge: "c-1" });
    expect(sink.events()).toEqual([]);
  });

  it("does not parse an unverified body", async () => {
    const handler = createWebhookHandler({ secrets: [S1], clock, sink: new BoundedEventSink() });
    const res = await handler(req("not json {", sign(SX, "not json {")));
    expect(res.status).toBe(401);
  });

  it("records gap/terminated separately and drops duplicate eventIds", async () => {
    const sink = new BoundedEventSink();
    const handler = createWebhookHandler({ secrets: [S1], clock, sink });
    const ev = '{"eventId":"e1","data":"$(whoami)"}';
    for (const b of [ev, ev, '{"type":"gap","truncated":true}', '{"type":"terminated"}']) {
      expect((await handler(req(b, sign(S1, b)))).status).toBe(200);
    }
    expect(sink.events()).toEqual([{ subscriptionId: "sub-1", eventId: "e1", data: "$(whoami)" }]);
    expect(sink.controls()).toEqual([
      { kind: "gap", subscriptionId: "sub-1", truncated: true, cursor: null },
      { kind: "terminated", subscriptionId: "sub-1" },
    ]);
    expect(sink.drain()).toHaveLength(1);
    expect(sink.events()).toEqual([]);
  });

  it("bounded sink drops oldest and records a gap", () => {
    const sink = new BoundedEventSink({ capacity: 2 });
    for (const id of ["a", "b", "c"]) sink.append({ subscriptionId: "s", eventId: id, data: null });
    expect(sink.events().map((e) => e.eventId)).toEqual(["b", "c"]);
    expect(sink.controls()).toEqual([{ kind: "gap", subscriptionId: "s", truncated: true }]);
    expect(sink.append({ subscriptionId: "s", eventId: "a", data: null })).toBe(false);
  });

  it("ListenerPort rejects http:// callback URLs", async () => {
    let closed = false;
    const port = { start: async () => ({ callbackUrl: "http://hooks.test/x", close: async () => { closed = true; } }) };
    await expect(bindListener(port, async () => ({ status: 200, headers: {}, body: "" }))).rejects.toBeInstanceOf(InsecureCallbackUrlError);
    expect(closed).toBe(true);
    const ok = { start: async () => ({ callbackUrl: "https://hooks.test/x", close: async () => {} }) };
    expect((await bindListener(ok, async () => ({ status: 200, headers: {}, body: "" }))).callbackUrl).toBe("https://hooks.test/x");
  });

  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".exchange.json")).sort();
  it("has fixtures", () => expect(files.length).toBeGreaterThan(0));
  for (const f of files) {
    const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as { id: string; mutants: string[] };
    it(`fixture ${fx.id} passes`, async () => {
      expect(fx.id.startsWith("ext/events/webhook/")).toBe(true);
      await runExchange(fx);
    });
    for (const m of fx.mutants) {
      it(`fixture ${fx.id} kills mutant ${m}`, async () => {
        expect(supportsMutant(m)).toBe(true);
        await expect(runExchange(fx, m)).rejects.toBeInstanceOf(ObservationMismatch);
      });
    }
  }
});
