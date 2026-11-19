import { expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExchangeFiles } from "@mcp-client/fixtures";
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

// The isolated card build may not have either provider. In the assembled workspace,
// use each provider's own exchange (including its mutant) through the public runner.
it.each(["auth", "mrtr", "elic", "sub", "cache"])("loads the compiled provider for %s", async area => {
  const provider = area === "auth" ? "auth" : "mrtr-cache";
  const dir = fileURLToPath(new URL(`../../fixtures/exchanges/${area}/`, import.meta.url));
  if (!existsSync(dir)) {
    const summary = await run({ ...fixture, id: `${area}/unavailable` }, true);
    expect(summary.results[0]).toMatchObject({
      ok: false, error: expect.stringContaining(`@mcp-client/${provider}/conformance`),
    });
    return;
  }
  const fx = loadExchangeFiles(dir).find(f => f.tier === "B");
  expect(fx, `no Tier B exchange for ${area}`).toBeDefined();
  const summary = await runConformance({ exchangesDir: dir, idGlob: fx!.id, mutate: true });
  expect(summary.ok, JSON.stringify(summary.results)).toBe(true);
  expect(summary.passed).toBeGreaterThan(0);
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
