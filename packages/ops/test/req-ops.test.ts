import { describe, expect, it } from "vitest";
import type { JsonRpcRequest } from "@mcp-client/core";
import { createOps, measure } from "../src/index.js";
import { installNetworkSpy, makeClient, ok, paramsOf } from "./helpers.js";

installNetworkSpy();

const LIST = {
  tools: [
    { name: "ok_name.1-x", inputSchema: { type: "object" } },
    { name: "bad name!", inputSchema: { type: "object" } },
    { name: "n".repeat(129), inputSchema: { type: "object" } },
    { name: "danger", inputSchema: { type: "object" }, annotations: { idempotentHint: true, readOnlyHint: true } },
  ],
};

describe("ops requirement evidence", () => {
  it("[OPS-TOOLS-4] non-conforming names are kept and flagged with nameWarnings", async () => {
    const { client } = makeClient(ok(LIST));
    const o = await createOps(client).tools.list();
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.tools.map((t) => t.name)).toEqual(LIST.tools.map((t) => t.name));
    expect(o.value.tools[0]!.nameWarnings).toEqual([]);
    expect(o.value.tools[1]!.nameWarnings).not.toEqual([]);
    expect(o.value.tools[2]!.nameWarnings).not.toEqual([]);
    await client.close();
  });

  it("[OPS-TOOLS-6] annotations are untrusted and an idempotentHint never enables retry", async () => {
    let calls = 0;
    const { client } = makeClient((req: JsonRpcRequest) => {
      if (req.method === "tools/list") return ok(LIST)(req);
      calls++;
      return { kind: "failure", failure: { kind: "stream-broken", message: "x" }, delivery: "maybe-delivered" };
    });
    const ops = createOps(client);
    const l = await ops.tools.list();
    if (l.kind !== "ok") throw new Error(l.kind);
    expect(l.value.tools[3]!.annotations).toEqual({ value: LIST.tools[3]!.annotations, trust: "untrusted" });
    const c = await ops.tools.call("danger", {});
    expect(c.kind).toBe("uncertain-write");
    expect(calls).toBe(1);
    const t = await createOps(makeClient(ok(LIST)).client, { serverTrusted: true }).tools.list();
    if (t.kind !== "ok") throw new Error(t.kind);
    expect(t.value.tools[3]!.annotations?.trust).toBe("trusted");
    await client.close();
  });

  it("[OPS-TOOLS-15] the raw complete result is returned untruncated; measure() only reports sizes", async () => {
    const big = "x".repeat(1_500_000);
    const result = { content: [{ type: "text", text: big }], structuredContent: { big } };
    const { client } = makeClient(ok(result));
    const o = await createOps(client).tools.call("t", {});
    if (o.kind !== "ok") throw new Error(o.kind);
    expect(o.value.raw).toEqual(result);
    const m = measure(o.value.raw);
    expect(m.blocks).toHaveLength(1);
    expect(m.totalBytes).toBeGreaterThan(3_000_000);
    await client.close();
  });

  it("[OPS-TOOLS-16] the caller timeoutMs is applied to tools/call", async () => {
    const { client } = makeClient(); // never answers
    const o = await createOps(client).tools.call("slow", {}, { timeoutMs: 20, idempotent: true });
    expect(o).toMatchObject({ kind: "transport-failure", failure: { kind: "timeout" } });
    await client.close();
  });

  it("[OPS-RES-5] https resource URIs are never fetched; only resources/read goes over the transport", async () => {
    const uri = "https://example.com/x";
    const { client, transport } = makeClient(ok({ contents: [{ uri, text: "t" }] }));
    const o = await createOps(client).resources.read(uri);
    expect(o.kind).toBe("ok");
    expect(transport.sent.map((s) => [s.method, paramsOf(s)])).toEqual([["resources/read", { uri }]]);
    await client.close();
    // installNetworkSpy fails this file if fetch/net/http/dns was touched.
  });
});
