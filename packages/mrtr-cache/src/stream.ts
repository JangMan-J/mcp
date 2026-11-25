import type { McpClient, RequestOptions, StreamHandle } from "@mcp/core";
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
      stream: true,
      idempotent: options.idempotent ?? true,
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
