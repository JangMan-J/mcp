import { afterEach, describe, expect, it } from "vitest";
import { StdioTransport } from "../src/index.js";

const transports: StdioTransport[] = [];
afterEach(async () => { await Promise.all(transports.map((t) => t.close())); transports.length = 0; });

function launch(script: string) {
  const t = new StdioTransport({ command: process.execPath, args: ["-e", script], graceMs: 150, termMs: 150 });
  transports.push(t);
  return t;
}
const ctx = () => ({ signal: new AbortController().signal, idempotent: false, timeoutMs: 2000 });
const READER = `const rl=require("readline").createInterface({input:process.stdin});`;

describe("stdio edge cases", () => {
  it("[EDGE-2] duplicate response for one id: second ignored, violation diagnostic", async () => {
    const t = launch(`${READER}rl.on("line",(l)=>{const m=JSON.parse(l);if(m.id===undefined)return;
      const r=JSON.stringify({jsonrpc:"2.0",id:m.id,result:{n:1}})+"\\n";const r2=JSON.stringify({jsonrpc:"2.0",id:m.id,result:{n:2}})+"\\n";
      process.stdout.write(r);setTimeout(()=>process.stdout.write(r2),20);});`);
    const ex = t.start({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, ctx());
    await expect(ex.done).resolves.toMatchObject({ kind: "response", message: { id: 1, result: { n: 1 } } });
    // follow-up request proves the stream continued and the duplicate was processed
    await new Promise((r) => setTimeout(r, 100));
    const ex2 = t.start({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, ctx());
    await expect(ex2.done).resolves.toMatchObject({ kind: "response", message: { id: 2, result: { n: 1 } } });
    const dups = t.diagnosticsSnapshot().filter((d) => d.kind === "violation" && d.message.includes("duplicate-or-late-response for id=1"));
    expect(dups.length).toBeGreaterThanOrEqual(1);
  });

  it("[EDGE-11] invalid UTF-8 on stdio yields an invalid-utf8 violation diagnostic", async () => {
    const t = launch(`${READER}rl.on("line",(l)=>{const m=JSON.parse(l);if(m.id===undefined)return;
      process.stdout.write(Buffer.from([0x7b,0xff,0xfe,0x7d,0x0a]));
      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{ok:true}})+"\\n");});`);
    const ex = t.start({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, ctx());
    await expect(ex.done).resolves.toMatchObject({ kind: "response", message: { id: 1, result: { ok: true } } });
    expect(t.diagnosticsSnapshot()).toContainEqual(expect.objectContaining({ kind: "violation", message: expect.stringContaining("invalid-utf8") }));
  });
});
