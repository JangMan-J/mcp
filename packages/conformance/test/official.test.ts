import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runOfficial } from "../src/official.js";

// Fake runner: writes <-o dir>/<scenario>-<ts>/checks.json per SDK_INTEGRATION.md; behaviour driven by FAKE_MODE.
const RUNNER = [
  'const fs = require("node:fs"), path = require("node:path");',
  'const a = process.argv, o = a[a.indexOf("-o") + 1], sc = a[a.indexOf("--scenario") + 1];',
  'const mode = process.env.FAKE_MODE || "pass";',
  'const d = path.join(o, sc.replace(/\\//g, "-") + "-1");',
  'fs.mkdirSync(d, { recursive: true });',
  'const guarded = mode !== "guard" || (!/assert-no-pi\\.mjs/.test(process.env.NODE_OPTIONS || "") && /--import(?:=| )[^ ]*assert-no-pi\\.mjs/.test(a[a.indexOf("--command") + 1]));',
  'const checks = mode === "fail" ? [{ id: "a", status: "SUCCESS" }, { id: "b", status: "FAILURE" }] : mode === "empty" ? [] : [{ id: "a", status: mode === "guard" && !guarded ? "FAILURE" : "SUCCESS" }];',
  'if (mode !== "missing") fs.writeFileSync(path.join(d, "checks.json"), JSON.stringify(checks));',
  'process.exit(mode === "exit" ? 1 : 0);',
].join("\n");

describe("official runner", () => {
  it("requires a pinned checkout, exit 0 and one checks.json with only passing checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "official-"));
    const prevMode = process.env.FAKE_MODE;
    const prevCheckout = process.env.MCP_CONFORMANCE_CHECKOUT;
    delete process.env.MCP_CONFORMANCE_CHECKOUT;
    try {
      const checkout = join(root, "checkout");
      mkdirSync(join(checkout, "dist"), { recursive: true });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "runner", version: "1" }));
      writeFileSync(join(checkout, "dist/index.js"), RUNNER);
      const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
      git("init", "-q"); git("add", "."); git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
      const commit = git("rev-parse", "HEAD");
      const map = JSON.parse(readFileSync("packages/conformance/official-map.json", "utf8"));
      Object.assign(map.runner, { package: "runner", version: "1", commit, checkoutDir: "checkout" });
      expect(map.runner.clientArgs).toEqual(["client", "--command", "{cut}", "--scenario", "{scenario}", "--spec-version", "2026-07-28", "-o", "{outputDir}"]);
      map.catalog = { selected: true, authorizedBy: "test", reason: "" };
      map.cut = { authorized: true, path: "cut.js", reason: "" };
      map.scenarios = [{ id: "auth/example", specVersion: map.eligibility.specVersion, requirements: [], ...map.eligibility.requires }];
      mkdirSync(join(root, "packages/conformance"), { recursive: true });
      writeFileSync(join(root, "cut.js"), "");
      const save = () => writeFileSync(join(root, "packages/conformance/official-map.json"), JSON.stringify(map));
      save();
      const run = async (mode: string) => { process.env.FAKE_MODE = mode; return runOfficial(root); };

      const ok = await run("pass");
      expect(ok.ok).toBe(true);
      expect(ok.scenarios[0]?.result).toEqual({ checks: 1, passed: 1, failed: 0, statuses: { SUCCESS: 1 } });

      const previousOptions = process.env.NODE_OPTIONS;
      process.env.NODE_OPTIONS = "--import=file:///x/scripts/assert-no-pi.mjs";
      try {
        const guarded = await run("guard");
        expect(guarded.scenarios[0]?.ok).toBe(true);
      } finally {
        if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
      }

      const fail = await run("fail");
      expect(fail.ok).toBe(false);
      expect(fail.scenarios[0]?.error).toContain("1 failing check");
      expect(fail.scenarios[0]?.result).toMatchObject({ checks: 2, failed: 1 });

      expect((await run("missing")).scenarios[0]?.error).toContain("expected exactly one checks.json, found 0");
      expect((await run("empty")).scenarios[0]?.error).toContain("no checks");
      const exit = await run("exit");
      expect(exit.ok).toBe(false);
      expect(exit.scenarios[0]?.exitCode).toBe(1);
      expect(exit.scenarios[0]?.error).toContain("exit 1");

      map.runner.commit = "0".repeat(40); save();
      expect((await run("pass")).reasons.join()).toContain("checkout-pin-mismatch");
      map.runner.commit = commit;
      map.resultSchema = { source: "README", passedField: "passed", failedField: "failed", totalField: "total", notScoredField: "not_scored" };
      save();
      expect((await run("pass")).reasons.join()).toContain("result-schema-unavailable");
    } finally {
      if (prevMode === undefined) delete process.env.FAKE_MODE; else process.env.FAKE_MODE = prevMode;
      if (prevCheckout !== undefined) process.env.MCP_CONFORMANCE_CHECKOUT = prevCheckout;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
