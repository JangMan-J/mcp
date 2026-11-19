import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { ObservationMismatch, runExchange, supportsMutant } from "../src/conformance.js";

const fixturesDir = new URL("../../fixtures/exchanges/ext/ema/", import.meta.url);
const RESOLVED = new Set(["EXT-ema-3", "EXT-ema-5", "EXT-ema-6", "EXT-ema-10", "EXT-ema-11", "EXT-ema-12", "EXT-ema-13", "EXT-ema-14", "EXT-CAP-1", "EXT-REG-2", "EXT-REMOVE-1"]);

for (const filename of readdirSync(fixturesDir).filter((n) => n.endsWith(".exchange.json"))) {
  const fixture = JSON.parse(readFileSync(new URL(filename, fixturesDir), "utf8"));
  it(fixture.id, async () => {
    expect(fixture.tier).toBe("A");
    expect(fixture.binding).toBe("http");
    expect(fixture.pin).toBe("ext-page");
    expect(fixture.requirements.length).toBeGreaterThan(0);
    expect(fixture.mutants.length).toBeGreaterThan(0);
    await runExchange(fixture);
    for (const mutant of fixture.mutants) {
      expect(supportsMutant(mutant)).toBe(true);
      const err = await runExchange(fixture, mutant).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ObservationMismatch);
      expect((err as ObservationMismatch).isObservationMismatch).toBe(true);
      expect((err as Error).name).toBe("ObservationMismatch");
    }
  });
}

it("fixture requirement IDs resolve and are not unresolved", () => {
  const reqPath = new URL("../../conformance/requirements.json", import.meta.url);
  const doc = JSON.parse(readFileSync(reqPath, "utf8")) as { rows: { id: string; disposition: string }[] };
  const byId = new Map(doc.rows.map((r) => [r.id, r.disposition]));
  for (const filename of readdirSync(fixturesDir).filter((n) => n.endsWith(".exchange.json"))) {
    const fixture = JSON.parse(readFileSync(new URL(filename, fixturesDir), "utf8"));
    for (const id of fixture.requirements as string[]) {
      expect(RESOLVED.has(id)).toBe(true);
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id)).not.toBe("unresolved");
    }
  }
});

it("unknown mutants and malformed fixtures throw plain Error", async () => {
  const err = await runExchange({ id: "ext/ema/x", expect: { header: null } }, "nope").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ObservationMismatch);
  await expect(runExchange({ nope: true })).rejects.not.toBeInstanceOf(ObservationMismatch);
  expect(supportsMutant("nope")).toBe(false);
});
