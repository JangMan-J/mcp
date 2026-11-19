import { describe, expect, it } from "vitest";
import { createOps } from "../src/index.js";
import { installNetworkSpy, makeClient, ok } from "./helpers.js";

installNetworkSpy();

describe("ops edge cases", () => {
  it("[EDGE-14] unknown capability keys are preserved and not acted on", async () => {
    const { client, transport } = makeClient(ok({ tools: [], prompts: [] }));
    const caps = { tools: {}, "x-future": { feature: true }, futureThing: {} };
    const snapshot = JSON.stringify(caps);
    const ops = createOps(client, { capabilities: caps });
    expect((await ops.prompts.list()).kind).toBe("capability-absent");
    expect((await ops.tools.list()).kind).toBe("ok");
    expect(transport.sent.map((s) => s.method)).toEqual(["tools/list"]);
    expect(JSON.stringify(caps)).toBe(snapshot);
    await client.close();
  });

  it("[EDGE-15] duplicate tool names: first kept in force, duplicate warned", async () => {
    const { client } = makeClient(ok({ tools: [
      { name: "echo", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
      { name: "echo", inputSchema: { type: "object" } },
    ] }));
    const ops = createOps(client, { capabilities: { tools: {} } });
    const r = await ops.tools.list();
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.value.tools[0]!.nameWarnings).not.toContain("duplicate-name");
    expect(r.value.tools[1]!.nameWarnings).toContain("duplicate-name");
    // first schema (requires msg) is in force
    const bad = await ops.tools.call("echo", {});
    expect(bad.kind).not.toBe("ok");
    await client.close();
  });

  it("[EDGE-16] tool name with space/comma is accepted with a warning", async () => {
    const { client } = makeClient(ok({ tools: [{ name: "a b,c", inputSchema: { type: "object" } }] }));
    const ops = createOps(client, { capabilities: { tools: {} } });
    const r = await ops.tools.list();
    if (r.kind !== "ok") throw new Error(r.kind);
    expect(r.value.tools.map((t) => t.name)).toEqual(["a b,c"]);
    expect(r.value.tools[0]!.nameWarnings).toContain("name-not-1-128-of-[A-Za-z0-9_.-]");
    expect(r.value.excluded).toEqual([]);
    await client.close();
  });
});
