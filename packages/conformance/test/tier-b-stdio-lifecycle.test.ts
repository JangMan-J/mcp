import { describe, expect, it } from "vitest";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import { runTierBStdioLifecycleFixture } from "../src/tier-b-stdio-lifecycle.js";

const OWNED = [
  "stdio/noise-line", "stdio/oversize-line", "stdio/restart-loop-guard",
  "stdio/routing-progress-and-subscription", "stdio/shutdown-escalation", "stdio/stderr-not-error",
];

describe("Tier B stdio lifecycle", () => {
  const fixtures = loadExchangeFiles("packages/fixtures/exchanges/stdio").filter(f => OWNED.includes(f.id));

  it("loads all six owned fixtures", () => {
    expect(fixtures.map(f => f.id).sort()).toEqual([...OWNED].sort());
  });

  it("ignores fixtures it does not own", async () => {
    const other = loadExchangeFiles("packages/fixtures/exchanges/stdio").find(f => !OWNED.includes(f.id))!;
    expect(await runTierBStdioLifecycleFixture(other)).toBeUndefined();
  });

  for (const id of OWNED) {
    it(`${id}: baseline passes and every mutant is killed`, async () => {
      const fixture = fixtures.find(f => f.id === id)!;
      expect(await runTierBStdioLifecycleFixture(fixture), id).toMatchObject({ id, ok: true });
      const unknown = await runTierBStdioLifecycleFixture(fixture, "unsupported-mutant");
      expect(unknown).toMatchObject({ ok: false });
      expect(unknown?.failure).toBeUndefined();
      expect(fixture.mutants?.length).toBeGreaterThan(0);
      for (const mutant of fixture.mutants ?? []) {
        expect(await runTierBStdioLifecycleFixture(fixture, mutant), `${id}: ${mutant}`).toMatchObject({ ok: false, failure: "assertion" });
      }
    }, 20000);
  }
});
