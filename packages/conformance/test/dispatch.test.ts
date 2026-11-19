import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "../src/run.js";

const fixture = { id: "unregistered/x", tier: "B", script: [], expect: {}, mutants: ["broken"] };

async function run(fx: typeof fixture, mutate = false) {
  const dir = mkdtempSync(join(tmpdir(), "exchange-"));
  try {
    writeFileSync(join(dir, "test.exchange.json"), JSON.stringify(fx));
    return await runConformance({ exchangesDir: dir, mutate });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it.each(["auth", "consent", "mrtr", "elic", "sub", "cache"])("runs Tier A %s exchanges and kills their mutants", async area => {
  const exchangesDir = fileURLToPath(new URL("../../fixtures/exchanges/", import.meta.url));
  for (const mutate of [false, true]) {
    const summary = await runConformance({ exchangesDir, tier: "A", area, mutate });
    expect(summary.ok, JSON.stringify(summary.results.filter(r => !r.ok))).toBe(true);
    expect(summary.passed).toBeGreaterThan(0);
  }
});

it("rejects an unknown Tier B area rather than passing an empty script", async () => {
  const summary = await run(fixture);
  expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("unregistered") });
});

it("does not credit mutants when the unmutated fixture fails", async () => {
  const summary = await run({ ...fixture, tier: "A", expect: { wire: { totalRequests: 1 } } }, true);
  expect(summary.passed).toBe(0);
  expect(summary.results[0]?.error).toMatch(/wire totalRequests/i);
});
