#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "mcp-client-smoke-"));

try {
  const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", tmp], {
    cwd: root,
    encoding: "utf8",
  }).trim().split("\n").pop();
  const tarball = join(tmp, packed);

  const installDir = join(tmp, "app");
  execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "ignore" });
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-save", "--silent", tarball], { cwd: tmp, stdio: "inherit" });

  const subpaths = [
    "@jangmanj/mcp-client",
    "@jangmanj/mcp-client/core",
    "@jangmanj/mcp-client/auth",
    "@jangmanj/mcp-client/ops",
    "@jangmanj/mcp-client/mrtr-cache",
    "@jangmanj/mcp-client/telemetry-otel",
    "@jangmanj/mcp-client/transport-http",
    "@jangmanj/mcp-client/transport-stdio",
    "@jangmanj/mcp-client/ext-events",
    "@jangmanj/mcp-client/ext-server-cards",
    "@jangmanj/mcp-client/ext-skills",
  ];

  const checkScript = `
    const subpaths = ${JSON.stringify(subpaths)};
    for (const sp of subpaths) {
      const mod = await import(sp);
      if (!mod || typeof mod !== "object" || Object.keys(mod).length === 0) {
        throw new Error("Empty module export for " + sp);
      }
    }
    console.log("smoke-pack: ok (" + subpaths.length + " entrypoints)");
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", checkScript], { cwd: tmp, stdio: "inherit" });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
