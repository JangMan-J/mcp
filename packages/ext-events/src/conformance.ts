import { isDeepStrictEqual } from "node:util";
import {
  McpClient,
  NotificationQueue,
  createMonotonicIdGenerator,
  type Clock,
  type ExchangeEnd,
  type JsonRpcNotification,
  type Transport,
} from "@mcp-client/core";
import {
  EventsClient,
  createEventsExtension,
  EVENTS_EXTENSION_ID,
  openEventsStream,
  type Obj,
  type EventsOptions,
} from "./index.js";
import { object } from "./model.js";
export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}
export const supportsMutant = (m: string) =>
  [
    "events-force-peer",
    "events-drop-name",
    "events-lose-cursor",
    "events-skip-jitter",
    "events-auto-webhook",
  ].includes(m);
function malformed(): never {
  throw new Error("Malformed Events exchange");
}
export async function runExchange(
  fixture: unknown,
  mutant?: string,
): Promise<{ frames: { direction: "client" | "server"; message: unknown }[]; zeroWire?: true }> {
  if (mutant && !supportsMutant(mutant))
    throw new Error("Unknown Events mutant");
  if (
    !object(fixture) ||
    typeof fixture.id !== "string" ||
    !fixture.id.startsWith("ext/events/") ||
    !Array.isArray(fixture.script) ||
    !fixture.script.length ||
    !object(fixture.expect) ||
    !Object.keys(fixture.expect).length
  )
    malformed();
  let time = 0,
    reply: Obj = {},
    peer: Obj = {},
    endpointReady = false,
    queue: NotificationQueue<JsonRpcNotification> | undefined,
    streamId: unknown,
    page: string | undefined;
  const wire: unknown[] = [],
    observations: unknown[] = [],
    frames: unknown[] = [],
    aborts: unknown[] = [];
  const transcript: { direction: "client" | "server"; message: unknown }[] = [];
  const timers = new Map<() => void, number>();
  const clock: Clock = {
    now: () => time,
    setTimeout(fn, ms) {
      timers.set(fn, time + ms);
      return () => {
        timers.delete(fn);
      };
    },
  };
  const empty = { async *[Symbol.asyncIterator]() {} };
  const transport: Transport = {
    binding: "streamable-http",
    diagnostics: empty,
    async close() {},
    async notify(msg) { transcript.push({ direction: "client", message: structuredClone(msg) }); },
    start(req, ctx) {
      transcript.push({ direction: "client", message: structuredClone(req) });
      const { _meta, ...params } = req.params ?? {};
      wire.push({
        method: req.method,
        params,
        name: ctx.headersHint?.name ?? null,
        time,
      });
      if (req.method === "events/stream") {
        streamId = req.id;
        const q = new NotificationQueue<JsonRpcNotification>();
        queue = q;
        const done = new Promise<ExchangeEnd>((resolve) =>
          ctx.signal.addEventListener(
            "abort",
            () => {
              aborts.push(time);
              q.close();
              const message = { jsonrpc: "2.0" as const, id: req.id, result: {} };
              transcript.push({ direction: "server", message });
              resolve({ kind: "response", message });
            },
            { once: true },
          ),
        );
        return { notifications: q, done };
      }
      const message = {
        jsonrpc: "2.0" as const,
        id: req.id,
        result: { resultType: "complete", ...structuredClone(reply) },
      };
      transcript.push({ direction: "server", message });
      return { notifications: empty, done: Promise.resolve({ kind: "response" as const, message }) };
    },
  };
  const nextId = createMonotonicIdGenerator(),
    core = new McpClient({
      server: { key: "events" },
      transport,
      idGenerator: nextId,
    });
  const flags = { enabled: false, healthy: true },
    ext = createEventsExtension(flags),
    registration = core.use(ext);
  const open = openEventsStream(transport, nextId, () =>
    ext.capabilities(true),
  );
  const opts: EventsOptions = {
    extension: ext,
    clock,
    jitterMs: () => (mutant === "events-skip-jitter" ? 1 : 10),
    peerCapabilities: () =>
      mutant === "events-force-peer"
        ? { extensions: { [EVENTS_EXTENSION_ID]: {} } }
        : peer,
    request: (m, p, o) =>
      core.request(
        m,
        mutant === "events-lose-cursor" && "cursor" in p
          ? { ...p, cursor: null }
          : p,
        mutant === "events-drop-name" ? {} : o,
      ),
    openStream: open,
    enableWebhook: mutant === "events-auto-webhook",
  };
  const client = new EventsClient(opts),
    id = client.subscription("mail", { folder: "inbox" });
  let push: { close(): void } | undefined;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    for (const s of fixture.script) {
      if (!object(s)) malformed();
      if (object(s.reply)) reply = s.reply;
      switch (s.do) {
        case "enable":
          flags.enabled = s.value === true;
          break;
        case "healthy":
          flags.healthy = s.value === true;
          break;
        case "peer":
          peer = object(s.value)
            ? { extensions: { [EVENTS_EXTENSION_ID]: s.value } }
            : {};
          break;
        case "caps":
          observations.push([
            ext.health(),
            ext.settings() ?? null,
            ext.capabilities(true),
            client.expectsListChanged(),
          ]);
          break;
        case "remove":
          registration.dispose();
          break;
        case "list":
          try {
            const r = await client.list(page);
            page = typeof r.nextCursor === "string" ? r.nextCursor : undefined;
            observations.push(page ?? null);
          } catch (e) {
            if (!(e instanceof Error) || e.message !== "Events unavailable")
              throw e;
            observations.push("unavailable");
          }
          break;
        case "poll":
          observations.push(await client.poll(id));
          break;
        case "local":
          observations.push(client.subscriptions());
          break;
        case "push":
          push = client.push(id, (m) =>
            frames.push(m.type === "error" ? { type: m.type } : m),
          );
          break;
        case "frame":
          if (!queue || typeof s.method !== "string" || !object(s.params))
            malformed();
          const notification = {
            jsonrpc: "2.0" as const,
            method: "notifications/events/" + s.method,
            params: {
              ...s.params,
              _meta: { "io.modelcontextprotocol/subscriptionId": streamId },
            },
          };
          transcript.push({ direction: "server", message: structuredClone(notification) });
          queue.push(notification);
          break;
        case "cancel":
          push?.close();
          break;
        case "advance": {
          if (typeof s.ms !== "number" || s.ms < 0) malformed();
          const until = time + s.ms;
          for (let i = 0; ; i++) {
            const t = [...timers].sort((a, b) => a[1] - b[1])[0];
            if (!t || t[1] > until) break;
            if (i > 100) malformed();
            time = t[1];
            timers.delete(t[0]);
            t[0]();
            await flush();
          }
          time = until;
          break;
        }
        case "endpoint":
          if (typeof s.url !== "string" || typeof s.secret !== "string")
            malformed();
          endpointReady = s.ready === true;
          opts.endpoint = {
            url: s.url,
            secret: s.secret,
            isReady: () => endpointReady,
          };
          break;
        case "webhook":
          opts.enableWebhook =
            mutant === "events-auto-webhook" || s.value === true;
          break;
        case "subscribe":
          try {
            const r = await client.subscribe(id);
            observations.push({ cursor: r.cursor, gap: r.gap });
          } catch (e) {
            if (
              !(e instanceof Error) ||
              !["Invalid webhook endpoint", "Webhook unavailable"].includes(
                e.message,
              )
            )
              throw e;
            observations.push("blocked");
          }
          break;
        case "unsubscribe":
          await client.unsubscribe(id);
          break;
        default:
          malformed();
      }
      await flush();
    }
    const observed: Obj = { wire, observations, frames, aborts };
    for (const [key, v] of Object.entries(fixture.expect)) {
      if (!Object.hasOwn(observed, key) || !Array.isArray(v)) malformed();
      if (!isDeepStrictEqual(v, observed[key]))
        throw new ObservationMismatch(
          `${fixture.id} ${key}: ${JSON.stringify(observed[key])}`,
        );
    }
  } finally {
    client.dispose();
    await core.close();
  }
  return transcript.length ? { frames: transcript } : { frames: transcript, zeroWire: true };
}
