#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  execFileSync("npm", ["init", "-y"], { cwd: tmp, stdio: "ignore" });
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-save", "--silent", tarball, "@types/node"], { cwd: tmp, stdio: "inherit" });

  const subpaths = [
    "@jangmanj/mcp-client",
    "@jangmanj/mcp-client/core",
    "@jangmanj/mcp-client/client",
    "@jangmanj/mcp-client/testing",
    "@jangmanj/mcp-client/server-events",
    "@jangmanj/mcp-client/server",
    "@jangmanj/mcp-client/server-transport",
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

  // 1. ESM dynamic import check across all 11 entrypoints
  const esmScript = `
    const subpaths = ${JSON.stringify(subpaths)};
    for (const sp of subpaths) {
      const mod = await import(sp);
      if (!mod || typeof mod !== "object" || Object.keys(mod).length === 0) {
        throw new Error("Empty ESM export for " + sp);
      }
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", esmScript], { cwd: tmp, stdio: "inherit" });

  // 2. CJS require(esm) check across all 11 entrypoints (Node >= 22.12 / 22.19)
  const cjsScript = `
    const { createRequire } = require("node:module");
    const req = createRequire(${JSON.stringify(join(tmp, "package.json"))});
    const subpaths = ${JSON.stringify(subpaths)};
    for (const sp of subpaths) {
      const mod = req(sp);
      if (!mod || typeof mod !== "object" || Object.keys(mod).length === 0) {
        throw new Error("Empty CJS export for " + sp);
      }
    }
  `;
  execFileSync(process.execPath, ["--input-type=commonjs", "-e", cjsScript], { cwd: tmp, stdio: "inherit" });

  // 3. Consumer TypeScript check (skipLibCheck: false, types: [], NodeNext)
  const consumerTs = subpaths
    .map((sp, i) => `import * as m${i} from ${JSON.stringify(sp)};\nvoid m${i};`)
    .join("\n") + "\n";
  writeFileSync(join(tmp, "consumer.ts"), consumerTs);
  writeFileSync(
    join(tmp, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          types: ["node"],
          noEmit: true,
        },
        include: ["consumer.ts"],
      },
      null,
      2
    )
  );
  const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(tscBin)) {
    execFileSync(process.execPath, [tscBin, "--noEmit", "-p", join(tmp, "tsconfig.json")], {
      cwd: tmp,
      stdio: "inherit",
    });
  } else {
    execFileSync(join(root, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", join(tmp, "tsconfig.json")], {
      cwd: tmp,
      stdio: "inherit",
    });
  }

  console.log(`smoke-pack: ok (${subpaths.length} entrypoints: ESM, CJS, tsc --noEmit)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
