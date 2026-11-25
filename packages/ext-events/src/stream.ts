import {
  NotificationQueue,
  type JsonRpcNotification,
  type IdGenerator,
  type RequestId,
  type Outcome,
  type Transport,
} from "@mcp/core";
import type { EventsOptions, Obj } from "./index.js";

/** Use the host's authenticated transport, shared request-id allocator and per-request metadata. */
export function openEventsStream(
  transport: Transport & {
    registerSubscription?(
      id: RequestId,
      fn: (n: JsonRpcNotification) => void,
    ): () => void;
  },
  nextId: IdGenerator,
  meta: () => Obj,
): NonNullable<EventsOptions["openStream"]> {
  return (method, params, opts) => {
    const id = nextId(),
      controller = new AbortController();
    const routed =
      transport.binding === "stdio" && transport.registerSubscription
        ? new NotificationQueue<JsonRpcNotification>()
        : undefined;
    const detach = routed
      ? transport.registerSubscription!(id, (n) => {
          routed.push(n);
        })
      : undefined;
    const cleanup = () => {
      detach?.();
      routed?.close();
    };
    let exchange;
    try {
      exchange = transport.start(
        { jsonrpc: "2.0", id, method, params: { ...params, _meta: meta() } },
        { ...opts, signal: controller.signal, idempotent: true, timeoutMs: 0 },
      );
    } catch (error) {
      cleanup();
      throw error;
    }
    const notifications = routed ?? exchange.notifications;
    const info = {
      requestId: id,
      method,
      binding: transport.binding,
      attempts: 1,
    };
    return {
      id,
      close: () => {
        cleanup();
        controller.abort();
      },
      [Symbol.asyncIterator]: () => notifications[Symbol.asyncIterator](),
      done: exchange.done.finally(cleanup).then((end): Outcome<unknown> => {
        if (end.kind === "failure")
          return {
            kind: "transport-failure",
            failure: end.failure,
            meta: info,
            safeToRetry: true,
          };
        if (end.message.id !== id)
          return {
            kind: "protocol-violation",
            detail: "Events stream id mismatch",
            meta: info,
          };
        if ("error" in end.message)
          return { kind: "jsonrpc-error", ...end.message.error, meta: info };
        return { kind: "ok", value: end.message.result, meta: info };
      }),
    };
  };
}
