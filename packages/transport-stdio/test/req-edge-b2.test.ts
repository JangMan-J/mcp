import { afterEach, describe, expect, it } from "vitest";
import type { Exchange } from "@mcp-client/core";
import { META_SUBSCRIPTION_ID, StdioTransport } from "../src/index.js";

const transports: StdioTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.map((t) => t.close()));
  transports.length = 0;
});

// Inline child: waits for listen (id 5) and tools/list (id 6), then interleaves
// notifications tagged with subscriptionId 5 around the response to id 6.
const script = `
const K = ${JSON.stringify(META_SUBSCRIPTION_ID)};
const seen = new Set(); let buf = "";
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const note = (method, extra = {}) => out({ jsonrpc: "2.0", method, params: { ...extra, _meta: { [K]: 5 } } });
process.stdin.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line); if (m.id !== undefined) seen.add(m.id);
    if (seen.has(5) && seen.has(6) && !seen.has("done")) {
      seen.add("done");
      note("notifications/subscriptions/acknowledged", { notifications: { toolsListChanged: true } });
      note("notifications/tools/list_changed");
      out({ jsonrpc: "2.0", id: 6, result: { tools: [], interleaved: true } });
      note("notifications/tools/list_changed");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

async function drain(e: Exchange) {
  const r = [];
  for await (const n of e.notifications) r.push(n);
  return r;
}

describe("EDGE-26", () => {
  it("[EDGE-26] listen notifications interleaved with a response route by subscriptionId, not as the response", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["-e", script],
      graceMs: 150,
      termMs: 150,
    });
    transports.push(transport);
    const ctx = () => ({ signal: new AbortController().signal, idempotent: false, timeoutMs: 2000 });
    const listen = transport.start(
      { jsonrpc: "2.0", id: 5, method: "subscriptions/listen", params: { notifications: { toolsListChanged: true } } },
      ctx(),
    );
    const list = transport.start({ jsonrpc: "2.0", id: 6, method: "tools/list", params: {} }, ctx());
    await expect(list.done).resolves.toMatchObject({
      kind: "response",
      message: { id: 6, result: { interleaved: true } },
    });
    expect(await drain(list)).toEqual([]);
    const it = listen.notifications[Symbol.asyncIterator]();
    const got = [];
    for (let i = 0; i < 3; i++) got.push((await it.next()).value);
    expect(got.map((n) => n.method)).toEqual([
      "notifications/subscriptions/acknowledged",
      "notifications/tools/list_changed",
      "notifications/tools/list_changed",
    ]);
    for (const n of got) expect(n.params?._meta).toEqual({ [META_SUBSCRIPTION_ID]: 5 });
  });
});
