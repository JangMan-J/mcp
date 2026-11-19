import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { runExchange } from "../src/conformance.js";
for (const area of ["mrtr", "elic", "sub", "cache"]) {
  const dir = new URL(`../../fixtures/exchanges/${area}/`, import.meta.url);
  for (const file of readdirSync(dir).filter((f) =>
    f.endsWith(".exchange.json"),
  )) {
    const fixture = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    describe(fixture.id, () => {
      it("satisfies the recorded exchange", () => runExchange(fixture));
      for (const mutant of fixture.mutants)
        it(`detects ${mutant}`, async () => {
          await expect(runExchange(fixture, mutant)).rejects.toThrow();
        });
    });
  }
}
