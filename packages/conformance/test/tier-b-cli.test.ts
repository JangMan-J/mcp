import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import type { HarnessAdapter } from "../src/adapter.js";
import { runConformance } from "../src/run.js";
import { runTierBFixture } from "../src/tier-b.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const exchangesDir = join(repoRoot, "packages/fixtures/exchanges");
const fixtureFile = (rel: string) => JSON.parse(readFileSync(join(exchangesDir, rel), "utf8")) as Record<string, unknown>;

const tmpDirs: string[] = [];
function dirWith(...fixtures: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tier-b-cli-"));
  tmpDirs.push(dir);
  fixtures.forEach((f, i) => writeFileSync(join(dir, `f${i}.exchange.json`), JSON.stringify(f)));
  return dir;
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

describe("Tier B dispatch through runConformance", () => {
  for (const area of ["auth", "sub"]) {
    for (const mutate of [false, true]) {
      it(`dispatches Tier B ${area} fixtures (mutate=${mutate})`, async () => {
        const summary = await runConformance({ exchangesDir, tier: "B", area, mutate });
        expect(summary.total).toBeGreaterThan(0);
        expect(summary.results.filter((r) => !r.ok)).toEqual([]);
        expect(summary.results.every((r) => !("mutationKilled" in r))).toBe(true);
        if (mutate) expect(summary.results.every((r) => r.mutant !== undefined)).toBe(true);
      }, 120000);
    }
  }

  for (const area of ["auth", "sub"]) {
    it(`lets opts.adapter override Tier B ${area} provider dispatch`, async () => {
      let created = 0;
      const adapter = { create() { created += 1; throw new Error("explicit adapter used"); } } as unknown as HarnessAdapter;
      const summary = await runConformance({ exchangesDir, tier: "B", area, adapter });
      expect(created).toBe(summary.total);
      expect(summary.results.every((r) => r.error === "explicit adapter used")).toBe(true);
    });
  }

  it("does not count a failed baseline as killed mutants", async () => {
    const broken = { ...fixtureFile("sub/binding/graceful-close.exchange.json"), id: "sub/broken-baseline", expect: { observe: { reason: "never" } } };
    const summary = await runConformance({ exchangesDir: dirWith(broken), tier: "B", area: "sub", mutate: true });
    expect(summary.ok).toBe(false);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline failed") });
    // No mutant ran, so nothing was killed.
    expect(summary.results[0]).not.toHaveProperty("mutant");
    expect(summary.passed).toBe(0);
  }, 60000);

  it("does not count unsupported mutants as kills", async () => {
    const sub = { ...fixtureFile("sub/binding/graceful-close.exchange.json"), mutants: ["bogus-mutant"] };
    const auth = { ...fixtureFile("auth/http-binding-bearer.exchange.json"), mutants: ["bogus-mutant"] };
    const summary = await runConformance({ exchangesDir: dirWith(sub, auth), tier: "B", mutate: true });
    expect(summary.ok).toBe(false);
    expect(summary.results).toHaveLength(2);
    for (const r of summary.results) {
      expect(r).toMatchObject({ ok: false, mutant: "bogus-mutant" });
      expect(r).not.toHaveProperty("failure", "assertion");
    }
  }, 60000);

  it("does not count malformed scripts or non-ObservationMismatch subscription errors as kills", async () => {
    const [fixture] = loadExchangeFiles(join(exchangesDir, "sub/binding")).filter((f) => f.id === "sub/graceful-close");
    const malformed = { ...fixture!, script: [...fixture!.script, ...fixture!.script] };
    const wrongBinding = { ...fixture!, binding: "ws" } as unknown as typeof fixture;
    for (const fx of [malformed, wrongBinding!]) {
      for (const mutant of [undefined, fixture!.mutants[0]]) {
        const result = await runTierBFixture(fx, mutant);
        expect(result?.ok).toBe(false);
        expect(result).not.toHaveProperty("failure", "assertion");
        expect(result?.mutationKilled).toBeUndefined();
      }
    }
    const summary = await runConformance({ exchangesDir: dirWith({ ...fixtureFile("sub/binding/graceful-close.exchange.json"), script: [{ do: "graceful-close" }, { do: "graceful-close" }] }), tier: "B", mutate: true });
    expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline failed") });
    expect(summary.results[0]).not.toHaveProperty("failure", "assertion");
  }, 60000);

  it("marks real observation mismatches as assertion failures", async () => {
    const [fixture] = loadExchangeFiles(join(exchangesDir, "sub/binding")).filter((f) => f.id === "sub/graceful-close");
    const result = await runTierBFixture(fixture!, fixture!.mutants[0]);
    expect(result).toMatchObject({ ok: false, failure: "assertion", mutationKilled: true });
  }, 60000);
});

describe("compiled conformance CLI", () => {
  const cli = join(repoRoot, "packages/conformance/dist/cli.js");
  for (const area of ["auth", "sub"]) {
    for (const mutate of [false, true]) {
      it(`run --tier B --area ${area}${mutate ? " --mutate" : ""} exits 0`, () => {
        const args = [cli, "run", "--tier", "B", "--area", area, ...(mutate ? ["--mutate"] : [])];
        // execFileSync throws on non-zero exit.
        const out = execFileSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        expect(out).not.toMatch(/FAIL|VACUOUS|Unhandled/);
      }, 120000);
    }
  }
});
