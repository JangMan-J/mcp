import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runOfficial } from "../src/official.js";

describe("official runner", () => {
  it("requires a pinned checkout and exactly one scored pass", async () => {
    const root = mkdtempSync(join(tmpdir(), "official-"));
    try {
      const checkout = join(root, "checkout");
      mkdirSync(join(checkout, "dist"), { recursive: true });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "runner", version: "1" }));
      writeFileSync(join(checkout, "dist/index.js"), 'console.log(JSON.stringify({passed:1,failed:0,total:1,not_scored:0}));');
      const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
      git("init", "-q"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      const commit = git("rev-parse", "HEAD");
      const map = JSON.parse(readFileSync("packages/conformance/official-map.json", "utf8"));
      Object.assign(map.runner, { package: "runner", version: "1", commit, checkoutDir: "checkout", clientArgs: ["client", "--command", "{cut}", "--scenario", "{scenario}", "--spec-version", "2026-07-28", "--output", "json"] });
      map.catalog = { selected: true, authorizedBy: "test", reason: "" };
      map.cut = { authorized: true, path: "cut.js", reason: "" };
      map.resultSchema = { source: "README", passedField: "passed", failedField: "failed", totalField: "total", notScoredField: "not_scored" };
      map.scenarios = [{ id: "example", specVersion: map.eligibility.specVersion, requirements: [], ...map.eligibility.requires }];
      mkdirSync(join(root, "packages/conformance"), { recursive: true });
      writeFileSync(join(root, "cut.js"), "");
      const save = () => writeFileSync(join(root, "packages/conformance/official-map.json"), JSON.stringify(map));
      save();
      expect((await runOfficial(root)).ok).toBe(true);
      map.runner.commit = "0".repeat(40); save();
      expect((await runOfficial(root)).reasons.join()).toContain("checkout-pin-mismatch");
      map.runner.commit = commit; save();
      writeFileSync(join(checkout, "dist/index.js"), 'console.log(JSON.stringify({passed:1,failed:0,total:1,not_scored:1}));');
      git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "invalid summary");
      map.runner.commit = git("rev-parse", "HEAD"); save();
      const invalid = await runOfficial(root);
      expect(invalid.scenarios[0]?.error).toContain("not exactly one passed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
