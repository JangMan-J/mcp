// Standalone fixture driver. No filesystem access or test runner dependency.
import { isDeepStrictEqual } from "node:util";
import {
  NotificationQueue,
  type Clock,
  type Outcome,
  type StreamHandle,
  type RequestOptions,
} from "@mcp-client/core";
import { MrtrSession } from "./mrtr.js";
import {
  SubscriptionManager,
  SUBSCRIPTION_ID,
  type Subscription,
} from "./subscriptions.js";
import { ResultCache } from "./cache.js";
import {
  elicitationCapabilities,
  type ElicitationOptions,
  type Decision,
  type FormResponse,
} from "./elicitation.js";
import { object, type Obj, type RequestFn } from "./common.js";
const obj = (v: unknown): Obj => {
  if (!object(v)) throw Error("expected object");
  return v;
};
const arr = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw Error("expected array");
  return v;
};
const str = (v: unknown): string => {
  if (typeof v !== "string") throw Error("expected string");
  return v;
};
class FakeClock implements Clock {
  time = 0;
  timers = new Map<() => void, number>();
  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    this.timers.set(fn, this.time + ms);
    return () => {
      this.timers.delete(fn);
    };
  }
  advance(ms: number) {
    const end = this.time + ms;
    for (let i = 0; i < 1000; i++) {
      const next = [...this.timers].sort((a, b) => a[1] - b[1])[0];
      if (!next || next[1] > end) {
        this.time = end;
        return;
      }
      this.time = next[1];
      this.timers.delete(next[0]);
      next[0]();
    }
    throw Error("timer loop");
  }
}
export async function runExchange(
  fixture: unknown,
  mutant?: string,
): Promise<void> {
  if (
    mutant &&
    ![
      "complete-interim",
      "positive-ttl",
      "raw-result",
      "strip-state",
      "share-context",
      "skip-invalidation",
      "ignore-ttl",
      "no-security-purge",
      "ignore-error",
      "ignore-notify-kind",
      "no-capability-gate",
      "drop-route",
      "drop-reconnect",
      "no-ports",
      "advertise-all",
      "ignore-cursor",
      "drop-ack-timer",
      "no-cache",
      "strip-retry-fields",
      "force-http",
    ].includes(mutant)
  )
    throw Error(`unknown mutant ${mutant}`);
  const fx = obj(fixture),
    cfg = obj(obj(fx.client ?? {}).setup ?? {}),
    clock = new FakeClock();
  let auth = "A",
    next = 0;
  const wire: Obj[] = [],
    ui: Obj[] = [],
    opened: string[] = [],
    diags: string[] = [],
    closed: (number | string)[] = [];
  const observations: Obj = { wire, ui, opened, diags, closed },
    diagnostic = (d: string) => {
      diags.push(d);
    };
  const decisions = [...arr(cfg.decisions ?? [])];
  const actions: ElicitationOptions = {
    serverLabel: "configured server",
    port: {
      ...(cfg.form === true &&
        mutant !== "no-ports" && {
          form: async (p, signal) => {
            ui.push({ ...p });
            const d = decisions.shift();
            if (d === "wait")
              return new Promise<FormResponse>((_, reject) =>
                signal.addEventListener("abort", () => reject(Error("abort")), {
                  once: true,
                }),
              );
            return (d ?? { action: "cancel" }) as FormResponse;
          },
        }),
      ...(cfg.url === true &&
        mutant !== "no-ports" && {
          url: async (p) => {
            ui.push({ ...p });
            return (decisions.shift() ?? "decline") as Decision;
          },
        }),
    },
    ...(cfg.browser === true && {
      browser: {
        open: async (u: string) => {
          opened.push(u);
        },
      },
    }),
    diagnostic,
  };
  observations.caps =
    mutant === "advertise-all"
      ? { elicitation: { form: {}, url: {} } }
      : elicitationCapabilities(actions);
  const cache = new ResultCache({
    sharePublic: cfg.sharePublic === true,
    now: () => (mutant === "ignore-ttl" ? 0 : clock.now()),
    diagnostic,
  });
  const replies = [...arr(cfg.replies ?? [])];
  const raw: RequestFn = async (method, params) => {
    if (mutant === "strip-state") {
      const { requestState, ...rest } = params;
      params = rest;
    }
    const id = ++next;
    wire.push({ method, params: structuredClone(params), id });
    const meta = { method, attempts: 1, binding: "inproc", requestId: id };
    const r = obj(replies.shift() ?? { resultType: "complete" });
    if (r.error && mutant !== "ignore-error")
      return {
        kind: "jsonrpc-error",
        code: Number(obj(r.error).code),
        message: String(obj(r.error).message),
        meta,
      };
    if (r.failure && mutant !== "no-security-purge")
      return {
        kind: "transport-failure",
        failure: {
          kind: "http-status",
          message: "http error",
          status: Number(r.failure),
        },
        safeToRetry: false,
        meta,
      };
    return {
      kind: "ok",
      value: {
        ...r,
        ...(mutant === "positive-ttl" && { ttlMs: 999 }),
        ...(mutant === "complete-interim" && { resultType: "complete" }),
      },
      meta,
    };
  };
  const cached: RequestFn = (m, p, o) => {
    if (mutant === "ignore-cursor") {
      const { cursor, ...rest } = p;
      p = rest;
    }
    if (mutant === "strip-retry-fields") {
      const { inputResponses, requestState, ...rest } = p;
      p = rest;
    }
    return mutant === "no-cache"
      ? raw(m, p, o)
      : cache.run(
          {
            serverRef: "s",
            authContextId: mutant === "share-context" ? "A" : auth,
          },
          m,
          p,
          o,
          raw,
        );
  };
  const session = new MrtrSession(cached, {
    ...actions,
    clock,
    ...(typeof cfg.maxRounds === "number" && { maxRounds: cfg.maxRounds }),
  });
  const streams = new Map<
    number,
    { finish: (o: Outcome<unknown>) => void; queue: NotificationQueue<never> }
  >();
  const manager = new SubscriptionManager({
    binding:
      mutant === "force-http"
        ? "http"
        : fx.binding === "http"
          ? "http"
          : "stdio",
    serverRef: "s",
    clock,
    random: () => 0.5,
    ackTimeoutMs: mutant === "drop-ack-timer" ? Infinity : 10000,
    ...(mutant !== "no-capability-gate" &&
      object(cfg.capabilities) && { capabilities: cfg.capabilities }),
    ...(mutant !== "skip-invalidation" && { cache }),
    diagnostic,
    ...(mutant === "drop-reconnect" && { reconnect: "never" }),
    open(method, params) {
      const id = ++next;
      wire.push({ id, method, params });
      const queue = new NotificationQueue<never>();
      let finish!: (o: Outcome<unknown>) => void;
      const s: StreamHandle = {
        id,
        [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
        done: new Promise((r) => {
          finish = r;
        }),
        close() {
          closed.push(id);
          queue.close();
        },
      };
      streams.set(id, { finish, queue });
      return s;
    },
  });
  const listeners = new Map<string, Subscription>(),
    pending = new Map<string, Promise<Outcome<unknown>>>(),
    controllers = new Map<string, AbortController>();
  const settle = async () => {
    for (let i = 0; i < 24; i++) await Promise.resolve();
  };
  for (const x of arr(fx.script)) {
    const s = obj(x),
      name = String(s.as ?? "call");
    switch (s.do) {
      case "call": {
        const method = str(s.method),
          params = obj(s.params ?? {}),
          ac = new AbortController(),
          opts: RequestOptions = {
            signal: ac.signal,
            ...(s.manual === true && { mrtr: "manual" }),
          };
        controllers.set(name, ac);
        const promise = Promise.resolve(
          s.cacheOnly || mutant === "raw-result"
            ? cached(method, params, opts)
            : session.run(method, params, opts),
        );
        pending.set(name, promise);
        if (!s.pending) observations[name] = await promise;
        else await settle();
        break;
      }
      case "resume": {
        const o = await pending.get(str(s.target));
        if (o?.kind !== "mrtr-interim") throw Error("not resumable");
        observations[name] = await o.resume(
          s.responses ? obj(s.responses) : undefined,
        );
        break;
      }
      case "abort": {
        const ac = controllers.get(str(s.target));
        if (!ac) throw Error("unknown call");
        ac.abort();
        observations[String(s.target)] = await pending.get(str(s.target));
        break;
      }
      case "advance":
        clock.advance(Number(s.ms));
        break;
      case "auth":
        auth = str(s.context);
        break;
      case "notify-cache":
        if (mutant !== "skip-invalidation")
          cache.notification(
            "s",
            mutant === "ignore-notify-kind"
              ? "notifications/tools/list_changed"
              : str(s.method),
            obj(s.params ?? {}),
          );
        break;
      case "listen": {
        const l = manager.listen(obj(s.filter));
        listeners.set(name, l);
        observations[`${name}Events`] = [];
        void (async () => {
          for await (const n of l.events)
            (observations[`${name}Events`] as unknown[]).push(n.method);
        })();
        void l.acknowledged.then(
          (a) => {
            observations[`${name}Ack`] = a;
          },
          () => {},
        );
        break;
      }
      case "notify": {
        const id = s.id ?? listeners.get(str(s.target))?.id;
        const params = {
          ...obj(s.params ?? {}),
          _meta: { [SUBSCRIPTION_ID]: id },
        };
        if (mutant !== "drop-route")
          manager.route(
            { jsonrpc: "2.0", method: str(s.method), params },
            typeof s.stream === "number" ? s.stream : undefined,
          );
        break;
      }
      case "end": {
        const l = listeners.get(str(s.target));
        if (!l) throw Error("unknown listener");
        const stream = streams.get(Number(l.id))!;
        stream.queue.close();
        const meta = {
          method: "subscriptions/listen",
          attempts: 1,
          binding: "inproc",
          requestId: l.id,
        };
        stream.finish(
          s.abrupt
            ? {
                kind: "transport-failure",
                failure: { kind: "closed", message: "lost" },
                safeToRetry: true,
                meta,
              }
            : {
                kind: "ok",
                value: {
                  resultType: "complete",
                  _meta: { [SUBSCRIPTION_ID]: l.id },
                },
                meta,
              },
        );
        break;
      }
      case "close": {
        const l = listeners.get(str(s.target));
        if (!l) throw Error("unknown listener");
        l.close();
        break;
      }
      case "reconnected":
        if (mutant !== "drop-reconnect") manager.reconnected();
        break;
      default:
        throw Error(`unknown script action: ${String(s.do)}`);
    }
    await settle();
  }
  for (const [k, l] of listeners) {
    observations[k] = {
      state: l.state,
      id: l.id,
      ...(l.reason && { reason: l.reason }),
    };
  }
  const expected = obj(fx.expect);
  if (
    Object.keys(expected).length !== 1 ||
    !object(expected.observe) ||
    !Object.keys(expected.observe).length
  )
    throw Error("unknown or empty assertion");
  for (const [path, want] of Object.entries(expected.observe)) {
    let value: unknown = observations;
    for (const k of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, k))
        throw Error(`assertion path not found: ${path}`);
      value = (value as Obj)[k];
    }
    if (!isDeepStrictEqual(JSON.parse(JSON.stringify(value)), want))
      throw Error(
        `${String(fx.id)}: ${path} expected ${JSON.stringify(want)}, got ${JSON.stringify(value)}`,
      );
  }
}
