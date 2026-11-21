import { describe, expect, it } from "vitest";
import {
  McpClient,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportDiagnostic,
} from "../src/index.js";

function makeScriptedTransport(
  handler: (req: JsonRpcRequest) => ExchangeEnd | Promise<ExchangeEnd>,
): { transport: Transport; sent: JsonRpcRequest[] } {
  const sent: JsonRpcRequest[] = [];
  const transport: Transport = {
    binding: "stdio",
    start(msg) {
      sent.push(msg);
      const notifications: AsyncIterable<JsonRpcNotification> = { async *[Symbol.asyncIterator]() {} };
      const ex: Exchange = { notifications, done: Promise.resolve(handler(msg)) };
      return ex;
    },
    async notify() {},
    async close() {},
    diagnostics: { async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {} },
  };
  return { transport, sent };
}

describe("edge cases part 2 (core)", () => {
  it("[EDGE-24] echoes requestState verbatim via pure serializable mrtr-interim", async () => {
    const state = 'line1\nline2\r\n"quoted" \'single\' \\back é 🌍 {"x":1}';
    const { transport, sent } = makeScriptedTransport((req) => {
      const p = req.params as Record<string, unknown>;
      const result =
        p["requestState"] === undefined
          ? { resultType: "input_required", requestState: state, inputRequests: { a: { method: "elicitation/create", params: {} } } }
          : { resultType: "complete", content: [] };
      return { kind: "response", message: { jsonrpc: "2.0", id: req.id, result } };
    });
    const client = new McpClient({ transport, server: { key: "t" } });
    const first = await client.request("tools/call", { name: "x", arguments: {} });
    expect(first.kind).toBe("mrtr-interim");
    if (first.kind !== "mrtr-interim") return;
    expect("resume" in first).toBe(false);
    expect(first.requestState).toBe(state);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    const second = await client.request("tools/call", {
      name: "x",
      arguments: {},
      requestState: first.requestState,
      inputResponses: { a: { action: "accept", content: {} } },
    });
    expect(second.kind).toBe("ok");
    expect(sent).toHaveLength(2);
    const echoed = (sent[1]!.params as Record<string, unknown>)["requestState"];
    expect(echoed).toBe(state);
    await client.close();
  });
});
