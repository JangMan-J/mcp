import type { Clock, StreamHandle, RequestId } from "@mcp-client/core";
import { object, cursor, type Occurrence } from "./model.js";
export type PushMessage =
  | {
      type: "active";
      cursor: string | null;
      truncated: boolean;
      gap: boolean;
      heartbeatMs: number;
    }
  | { type: "event"; subscriptionId: RequestId; event: Occurrence }
  | { type: "terminated" | "error"; error: unknown };

/** A stream owns one watchdog. Retiring its handle invalidates all late frames and completions. */
export function watchStream(
  open: () => StreamHandle,
  clock: Clock,
  jitter: () => number,
  advance: (c: unknown) => void,
  accept: (p: unknown) => Occurrence | undefined,
  deliver: (m: PushMessage) => void,
) {
  let live: StreamHandle | undefined,
    stopped = false,
    timer: (() => void) | undefined;
  const retire = () => {
    timer?.();
    const old = live;
    live = undefined;
    old?.close();
  };
  const stop = () => {
    stopped = true;
    retire();
  };
  function connect() {
    if (stopped) return;
    let stream: StreamHandle;
    try {
      stream = open();
    } catch (error) {
      stop();
      deliver({ type: "error", error });
      return;
    }
    live = stream;
    const reconnect = () => {
      if (live !== stream) return;
      retire();
      timer = clock.setTimeout(connect, Math.max(1, jitter()));
    };
    let heartbeat = 0;
    const arm = () => {
      timer?.();
      timer = clock.setTimeout(reconnect, heartbeat * 2);
    };
    void stream.done.then(reconnect, reconnect);
    void (async () => {
      for await (const n of stream) {
        if (live !== stream) return;
        const p = n.params ?? {},
          id = object(p._meta)
            ? p._meta["io.modelcontextprotocol/subscriptionId"]
            : p.subscriptionId;
        if (id !== stream.id) continue;
        if (!heartbeat && n.method !== "notifications/events/active")
          throw new Error("Expected active as first Events notification");
        switch (n.method) {
          case "notifications/events/active": {
            if (
              typeof p.heartbeatMs !== "number" ||
              !Number.isFinite(p.heartbeatMs) ||
              p.heartbeatMs <= 0
            )
              throw new Error("Invalid Events heartbeat grant");
            heartbeat = p.heartbeatMs;
            advance(p.cursor);
            arm();
            deliver({
              type: "active",
              cursor: cursor(p.cursor),
              gap: p.truncated === true,
              truncated: p.truncated === true,
              heartbeatMs: heartbeat,
            });
            break;
          }
          case "notifications/events/event": {
            const event = accept(p);
            advance(p.cursor);
            arm();
            if (event)
              deliver({ type: "event", event, subscriptionId: stream.id });
            break;
          }
          case "notifications/events/heartbeat":
            advance(p.cursor);
            arm();
            break;
          case "notifications/events/error":
            arm();
            deliver({ type: "error", error: p.error });
            break;
          case "notifications/events/terminated":
            stop();
            deliver({ type: "terminated", error: p.error });
            return;
        }
      }
      reconnect();
    })().catch((error) => {
      if (live === stream) {
        deliver({ type: "error", error });
        reconnect();
      }
    });
  }
  connect();
  return stop;
}
