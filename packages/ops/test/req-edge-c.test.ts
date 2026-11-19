import { expect, it } from "vitest";
import { McpClient, type Transport } from "@mcp-client/core";
import { createOps } from "../src/index.js";

it("[EDGE-28] stops on the second copy of an opaque pagination cursor", async () => {
  const cursor = "verbatim+/= cursor";
  const sent: Array<{ method: string; cursor: unknown }> = [];
  const transport: Transport = {
    binding: "stdio",
    start(req) {
      sent.push({ method: req.method, cursor: req.params?.cursor });
      const page = sent.length <= 2 ? { tools: [], nextCursor: cursor } : { tools: [] };
      return {
        notifications: { async *[Symbol.asyncIterator]() {} },
        done: Promise.resolve({ kind: "response", message: { jsonrpc: "2.0", id: req.id, result: page } }),
      };
    },
    diagnostics: { async *[Symbol.asyncIterator]() {} },
    async notify() {},
    async close() {},
  };
  const client = new McpClient({ transport, server: { key: "cursor-repeat" } });
  try {
    const out = await createOps(client).tools.listAll({ maxPages: 5 });
    expect(out).toMatchObject({ kind: "protocol-violation", detail: { reason: "cursor-loop", pages: 2 } });
    expect(sent).toEqual([{ method: "tools/list", cursor: undefined }, { method: "tools/list", cursor }]);
  } finally {
    await client.close();
  }
});
