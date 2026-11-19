import {
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  type Transport,
  type IdGenerator,
  type StreamHandle,
  type Outcome,
} from "@mcp-client/core";
import type { ListenOptions } from "./subscriptions.js";
import type { Obj } from "./common.js";
/** Use the same id allocator as normal requests. Auth belongs to the injected transport. */
export function openListenStream(
  transport: Transport,
  nextId: IdGenerator,
  meta: () => Obj = () => ({
    [META_PROTOCOL_VERSION]: SUPPORTED_PROTOCOL_VERSION,
    [META_CLIENT_CAPABILITIES]: {},
  }),
): ListenOptions["open"] {
  return (method, params): StreamHandle => {
    const id = nextId(),
      ac = new AbortController(),
      ctx = { signal: ac.signal, idempotent: true, timeoutMs: 0 };
    const exchange = transport.start(
      { id, jsonrpc: "2.0", method, params: { ...params, _meta: meta() } },
      ctx,
    );
    const outcomeMeta = {
      requestId: id,
      method,
      attempts: 1,
      binding: transport.binding,
    };
    return {
      id,
      [Symbol.asyncIterator]: () =>
        exchange.notifications[Symbol.asyncIterator](),
      done: exchange.done.then((end): Outcome<unknown> => {
        if (end.kind === "failure")
          return {
            kind: "transport-failure",
            failure: end.failure,
            safeToRetry: true,
            meta: outcomeMeta,
          };
        if (end.message.id !== id)
          return {
            kind: "protocol-violation",
            detail: "subscription response id mismatch",
            meta: outcomeMeta,
          };
        if ("error" in end.message)
          return {
            kind: "jsonrpc-error",
            ...end.message.error,
            meta: outcomeMeta,
          };
        return { kind: "ok", value: end.message.result, meta: outcomeMeta };
      }), // Transport owns cancellation: stdio emits a priority notification; HTTP aborts the stream.
      close() {
        ac.abort();
      },
    };
  };
}
