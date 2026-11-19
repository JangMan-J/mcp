import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runExchange, supportsMutant, type OpsFixture } from "../src/conformance.js";
import { installNetworkSpy } from "./helpers.js";

installNetworkSpy();

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "../../fixtures/exchanges/ops");

const fixtures: OpsFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".exchange.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as OpsFixture);

const requirementIds = new Map<string, string>(
  (
    JSON.parse(readFileSync(join(HERE, "../../conformance/requirements.json"), "utf8")) as {
      rows: { id: string; disposition: string }[];
    }
  ).rows.map((r) => [r.id, r.disposition]),
);

describe("ops exchange fixtures", () => {
  it("found the ops fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(38);
  });

  for (const fx of fixtures) {
    describe(fx.id, () => {
      it("declares known, resolved requirement ids and at least one known mutant", () => {
        expect(fx.requirements.length).toBeGreaterThan(0);
        for (const id of fx.requirements) {
          const d = requirementIds.get(id);
          expect(d, `requirement ${id}`).toBeDefined();
          expect(d).not.toMatch(/^unresolved/);
        }
        expect(fx.mutants.length).toBeGreaterThan(0);
        for (const name of fx.mutants) expect(supportsMutant(name)).toBe(true);
      });

      it("passes", async () => {
        await runExchange(fx);
      });

      for (const name of fx.mutants) {
        it(`fails under mutant ${name}`, async () => {
          await expect(runExchange(fx, name)).rejects.toThrow();
        });
      }
    });
  }
});
