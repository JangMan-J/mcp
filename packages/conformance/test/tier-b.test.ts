import { describe, expect, it } from "vitest";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import { runTierBFixture } from "../src/tier-b.js";

describe("Tier B bindings", () => {
  it("runs subscription fixtures and detects their mutants", async () => {
    const fixtures = await loadExchangeFiles("packages/fixtures/exchanges/sub/binding");
    expect(fixtures).toHaveLength(8);
    for (const fixture of fixtures) {
      const result = await runTierBFixture(fixture);
      expect(result, fixture.id).toMatchObject({ ok: true });
      expect(await runTierBFixture(fixture, "unsupported-mutant"), fixture.id).toMatchObject({
        ok: false, error: expect.stringContaining("Unsupported mutant"),
      });
      expect((await runTierBFixture(fixture, "unsupported-mutant"))?.mutationKilled).toBeUndefined();
      for (const mutant of fixture.mutants ?? []) {
        expect(await runTierBFixture(fixture, mutant), `${fixture.id}: ${mutant}`).toMatchObject({ ok: false, mutationKilled: true, error: expect.stringContaining("Observation mismatch") });
      }
    }
  }, 60000);
});
