import { describe, expect, it } from "vitest";
import { McpClient, type FetchPort } from "@mcp-client/core";
import { HttpTransport } from "../src/index.js";

const URL1 = "https://mcp.example.test/mcp";

function sse(text: string): Response {
  return new Response(new TextEncoder().encode(text), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function harness(respond: (n: number) => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetchPort: FetchPort = {
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>);
      return respond(bodies.length);
    },
  };
  const client = new McpClient({ transport: new HttpTransport({ url: URL1, fetchPort }), server: { key: URL1 } });
  return { client, bodies };
}

// Stream ends without a response after the write was sent -> uncertain-write.
const broken = () => sse("");

describe("HTTP ambiguous writes", () => {
  it("[HTTP-AMBIG-3] re-issue is opt-in, uses a new id and links retryOf", async () => {
    const { client, bodies } = harness((n) =>
      n === 1
        ? broken()
        : new Response(JSON.stringify({ jsonrpc: "2.0", id: bodies[n - 1]!["id"], result: { content: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
    );
    const first = await client.request("tools/call", { name: "write", arguments: { x: 1 } });
    expect(first.kind).toBe("uncertain-write");
    if (first.kind !== "uncertain-write") return;
    const origId = first.uncertain.requestId;
    expect(bodies).toHaveLength(1);

    const refused = await client.request("tools/call", { name: "write", arguments: { x: 1 } }, { retryOf: origId });
    expect(refused.kind).toBe("local-error");
    expect(bodies).toHaveLength(1);

    const refusedFalse = await client.request(
      "tools/call",
      { name: "write", arguments: { x: 1 } },
      { retryOf: origId, acceptDuplicate: false },
    );
    expect(refusedFalse.kind).toBe("local-error");
    expect(bodies).toHaveLength(1);

    const again = await client.request(
      "tools/call",
      { name: "write", arguments: { x: 1 } },
      { retryOf: origId, acceptDuplicate: true },
    );
    expect(again.kind).toBe("ok");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!["id"]).not.toBe(origId);
    expect(again.meta.requestId).toBe(bodies[1]!["id"]);
    expect(again.meta.requestId).not.toBe(origId);
    expect(again.meta.retryOf).toBe(origId);
  });

  it("[HTTP-AMBIG-4] task handle seen before the break is kept on uncertain-write", async () => {
    const status = { jsonrpc: "2.0", method: "notifications/tasks/status", params: { taskId: "task-42", status: "working" } };
    const { client, bodies } = harness(() => sse(`data: ${JSON.stringify(status)}\n\n`));
    const out = await client.request("tools/call", { name: "write" });
    expect(out.kind).toBe("uncertain-write");
    if (out.kind !== "uncertain-write") return;
    expect(out.uncertain.taskHandle).toMatchObject({ taskId: "task-42" });
    expect(bodies).toHaveLength(1);

    const { client: c2 } = harness(() => broken());
    const plain = await c2.request("tools/call", { name: "write" });
    expect(plain.kind).toBe("uncertain-write");
    if (plain.kind === "uncertain-write") expect(plain.uncertain.taskHandle).toBeUndefined();
  });
});
