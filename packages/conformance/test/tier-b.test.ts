import { describe, expect, it } from "vitest";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import { runTierBFixture } from "../src/tier-b.js";

 describe("Tier B bindings", () => {
  it("runs subscription fixtures and detects their mutants", async () => {
    const fixtures = await loadExchangeFiles("packages/fixtures/exchanges/sub/binding");
    expect(fixtures.length).toBeGreaterThan(0);
    for (const fixture of fixtures) {
      const result = await runTierBFixture(fixture);
      expect(result, fixture.id).toMatchObject({ ok: true });
      for (const mutant of fixture.mutants ?? []) {
        expect(await runTierBFixture(fixture, mutant), `${fixture.id}: ${mutant}`).toMatchObject({ ok: false });
      }
    }
  }, 60000);
});
