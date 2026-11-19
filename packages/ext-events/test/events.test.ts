import { it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createEventsExtension, openEventsStream } from "../src/index.js";
import { StdioTransport } from "@mcp-client/transport-stdio";

it("routes a live stdio Events frame and cancels its request id on the wire", async () => {
  let ack!: (line: string) => void;
  const cancelled = new Promise<string>((r) => {
    ack = r;
  });
  const transport = new StdioTransport({
    command: process.execPath,
    args: [
      "-e",
      `
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='events/stream') console.log(JSON.stringify({jsonrpc:'2.0',method:'notifications/events/active',params:{heartbeatMs:50,_meta:{'io.modelcontextprotocol/subscriptionId':m.id}}}));
      if(m.method==='notifications/cancelled') console.error('cancelled:'+m.params.requestId);
    });`,
    ],
    onStderr: ack,
  });
  try {
    const open = openEventsStream(
      transport,
      () => 17,
      () => ({}),
    );
    const stream = open(
      "events/stream",
      { name: "mail", cursor: null },
      { headersHint: { name: "mail" } },
    );
    const first = await stream[Symbol.asyncIterator]().next();
    expect(first.value.method).toBe("notifications/events/active");
    stream.close();
    expect(await cancelled).toContain("cancelled:17");
  } finally {
    await transport.close();
  }
});
import {
  runExchange,
  ObservationMismatch,
  supportsMutant,
} from "../src/conformance.js";
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
it("keeps draft Events opt-in only", () => {
  const ext = createEventsExtension();
  expect(ext.stage).toBe("draft");
  expect(ext.defaultEnabled).toBe(false);
  expect(ext.capabilities(true)).toEqual({});
});
it("keeps inbound listeners outside the runtime and makes no unconditional delivery guarantee", () => {
  const files = readdirSync(new URL("../src/", import.meta.url), {
    recursive: true,
  }).filter((f) => typeof f === "string" && f.endsWith(".ts"));
  for (const f of files)
    expect(read("../src/" + f)).not.toMatch(
      /node:(http2?|https|net|tls|dgram)|createServer|\.listen\s*\(|exactly-once/i,
    );
  expect(read("../README.md")).not.toMatch(/exactly-once/i);
});
for (const name of [
  "capability-and-gating",
  "poll-and-list",
  "push-stream",
  "webhook-rpc-gating",
]) {
  it(name, async () => {
    const fixture = JSON.parse(
      read("../../fixtures/exchanges/ext/events/" + name + ".exchange.json"),
    );
    await runExchange(fixture);
    for (const mutant of fixture.mutants) {
      expect(supportsMutant(mutant)).toBe(true);
      await expect(runExchange(fixture, mutant)).rejects.toBeInstanceOf(
        ObservationMismatch,
      );
    }
  });
}
