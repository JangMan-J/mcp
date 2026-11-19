import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts/check-remove-ext.mjs");

it("check-remove-ext works for a synthetic dummy extension", () => {
  const dummy = join(repoRoot, "packages/ext-dummy");
  expect(existsSync(dummy)).toBe(false);
  mkdirSync(dummy, { recursive: true });
  try {
    writeFileSync(join(dummy, "package.json"), JSON.stringify({ name: "@mcp-client/ext-dummy", version: "0.1.0", private: true, type: "module" }));
    execFileSync(process.execPath, [script, "ext-dummy"], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
  } finally {
    rmSync(dummy, { recursive: true, force: true });
  }
}, 600_000);

it("check-remove-ext rejects invalid or missing extension dirs", () => {
  for (const bad of ["", "core", "../core", "ext-../core", "ext-Nope", "ext-does-not-exist"]) {
    const r = spawnSync(process.execPath, [script, ...(bad ? [bad] : [])], { cwd: repoRoot, encoding: "utf8" });
    expect(r.status, `arg '${bad}'`).toBe(2);
  }
});

for (const extDir of [
  "ext-client-credentials", "ext-enterprise-auth", "ext-tasks", "ext-skills",
  "ext-apps", "ext-server-cards", "ext-events", "ext-events-webhook",
]) {
  if (existsSync(join(repoRoot, "packages", extDir))) {
    it(`check-remove-ext works for ${extDir}`, () => {
      execFileSync(process.execPath, [script, extDir], { cwd: repoRoot, stdio: "pipe", encoding: "utf8" });
    }, 600_000);
  }
}
