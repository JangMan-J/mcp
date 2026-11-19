import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createCoreAdapter } from "../src/adapter.js";
import { runConformance, type RunOptions } from "../src/run.js";

const exchangesDir = fileURLToPath(new URL("../../fixtures/exchanges/", import.meta.url));

it.each(["auth", "consent", "mrtr", "elic", "sub", "cache", "ops", "wire", "ver", "prog", "smoke"])(
  "runs Tier A %s exchanges and detects their mutants by default",
  async (area) => {
    const options = { exchangesDir, tier: "A", area } as const;
    for (const mutate of [false, true]) {
      const summary = await runConformance({ ...options, mutate });
      expect(summary.results.filter((r) => !r.ok)).toEqual([]);
      expect(summary.passed).toBeGreaterThan(0);
    }
  },
);

const coreFixture = {
  id: "wire/custom",
  tier: "A",
  script: [{ do: "call", as: "call", method: "tools/list", abortBeforeSend: true }],
  expect: { wire: { totalRequests: 0 } },
  mutants: ["not-a-mutant"],
};

async function runSynthetic(fixture: object, options: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tier-a-"));
  try {
    writeFileSync(join(dir, "test.exchange.json"), JSON.stringify(fixture));
    return await runConformance({ ...options, exchangesDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("does not fall back to the core adapter for an unhandled fixture", async () => {
  const summary = await runSynthetic({ ...coreFixture, id: "other/custom" });
  expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Unhandled") });
});

it("does not count a missing script as a kill", async () => {
  for (const area of ["auth", "cache", "ops", "wire"]) {
    const summary = await runSynthetic({ ...coreFixture, id: `${area}/empty`, script: [], expect: {} }, { mutate: true });
    expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline") });
  }
});

it("does not count unsupported mutants or a failing baseline as killed", async () => {
  const unsupported = await runSynthetic(coreFixture, { mutate: true });
  expect(unsupported.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("mutant") });
  const baseline = await runSynthetic({ ...coreFixture, expect: { wire: { totalRequests: 9 } } }, { mutate: true });
  expect(baseline.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline") });
});

it("does not count a survivor as killed", async () => {
  const summary = await runSynthetic({ ...coreFixture, mutants: ["omit-protocol-version"] }, { mutate: true });
  expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("VACUOUS") });
});

it("uses an explicit adapter even for a provider-owned area, and reports adapter setup errors", async () => {
  const fixture = { ...coreFixture, id: "ops/custom" };
  for (const tier of ["A", "B"]) {
    expect((await runSynthetic({ ...fixture, tier }, { adapter: createCoreAdapter() })).ok).toBe(true);
  }
  const core = createCoreAdapter();
  const failedSetup = await runSynthetic(fixture, {
    mutate: true,
    adapter: { create(setup) {
      if (setup.mutant) throw new Error("broken setup");
      return core.create(setup);
    } },
  });
  expect(failedSetup.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("broken setup") });
});
