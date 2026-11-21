import type { McpClient, RequestOptions, StreamHandle } from "@mcp-client/core";
import type { ListenOptions } from "./subscriptions.js";

export type ListenClient = Pick<McpClient, "request"> & Partial<Pick<McpClient, "notify">>;

/** Opens a live `subscriptions/listen` stream through `McpClient.request(...)`. */
export function openListenStream(
  client: ListenClient,
  options: RequestOptions = {},
): ListenOptions["open"] {
  return (method, params): StreamHandle => {
    const req = client.request(method, params, {
      ...options,
      idempotent: options.idempotent ?? true,
      timeoutMs: options.timeoutMs ?? Number.POSITIVE_INFINITY,
    });
    return {
      id: req.id,
      [Symbol.asyncIterator]: () => req.notifications[Symbol.asyncIterator](),
      done: Promise.resolve(req),
      close() {
        req.cancel();
      },
    };
  };
}
