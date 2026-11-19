import { describe, expect, it } from "vitest";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import { runTierBStdioFixture } from "../src/tier-b-stdio.js";

const ids = ["batch-line-rejected", "cancel-inflight", "concurrent-out-of-order", "crash-write-uncertain", "frame-split-multibyte", "launch-and-lazy-discover"]
  .map(n => `stdio/${n}`);
const fixtures = loadExchangeFiles("packages/fixtures/exchanges/stdio").filter(f => ids.includes(f.id));

describe("tier B stdio runner", () => {
  it("loads all six fixtures", () => expect(fixtures.map(f => f.id).sort()).toEqual(ids));

  it("ignores fixtures it does not own", async () => {
    const other = loadExchangeFiles("packages/fixtures/exchanges/stdio").find(f => !ids.includes(f.id))!;
    expect(await runTierBStdioFixture(other)).toBeUndefined();
  });

  for (const f of fixtures) {
    it(`${f.id} baseline`, async () => {
      expect(await runTierBStdioFixture(f)).toEqual({ id: f.id, ok: true });
    }, 10_000);
    for (const m of f.mutants) {
      it(`${f.id} kills ${m}`, async () => {
        const r = await runTierBStdioFixture(f, m);
        expect(r).toMatchObject({ ok: false, failure: "assertion" });
      }, 10_000);
    }
    it(`${f.id} unknown mutant`, async () => {
      const r = await runTierBStdioFixture(f, "nope");
      expect(r?.ok).toBe(false);
      expect(r?.failure).toBeUndefined();
    });
  }
});
