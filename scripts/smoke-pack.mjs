#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "mcp-smoke-"));

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
    "@jangmanj/mcp",
    "@jangmanj/mcp/core",
    "@jangmanj/mcp/client",
    "@jangmanj/mcp/testing",
    "@jangmanj/mcp/server-events",
    "@jangmanj/mcp/server",
    "@jangmanj/mcp/server-transport",
    "@jangmanj/mcp/auth",
    "@jangmanj/mcp/callback",
    "@jangmanj/mcp/ops",
    "@jangmanj/mcp/mrtr-cache",
    "@jangmanj/mcp/telemetry-otel",
    "@jangmanj/mcp/transport-http",
    "@jangmanj/mcp/transport-stdio",
    "@jangmanj/mcp/ext-events",
    "@jangmanj/mcp/ext-server-cards",
    "@jangmanj/mcp/ext-skills",
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

  // 4. The published bin binds a callback and relays it, with no host process.
  const cli = join(tmp, "node_modules", "@jangmanj", "mcp", "dist", "callback", "index.js");
  const child = spawn(process.execPath, [cli, "--redirect-uri", "https://callbacks.invalid/cb", "--once"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  let output = "";
  let asked = false;
  const relayed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp-callback stalled: ${output}`)), 10_000);
    const onLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      events.push(event);
      if (event.event === "listening" && !asked) {
        asked = true;
        const address = new URL(event.address);
        const req = request({
          port: Number(address.port), host: "127.0.0.1",
          path: `${address.pathname}?code=smoke&state=s`, headers: { host: "callbacks.invalid" },
        }, response => { response.resume(); response.on("end", () => {}); });
        req.on("error", reject);
        req.end();
      }
      if (event.event === "closed") { clearTimeout(timer); resolve(events.find((item) => item.event === "callback")); }
    };
    let pending = "";
    const feed = (chunk) => {
      output += chunk;
      pending += chunk;
      for (let index = pending.indexOf("\n"); index !== -1; index = pending.indexOf("\n")) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", feed);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", feed);
    child.on("error", reject);
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  if (code !== 0) throw new Error(`mcp-callback exited ${code}: ${output}`);
  if (relayed?.params?.code !== "smoke") throw new Error(`mcp-callback did not relay: ${output}`);
  if (!execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).includes("--redirect-uri")) {
    throw new Error("mcp-callback --help did not print usage");
  }

  console.log(`smoke-pack: ok (${subpaths.length} entrypoints: ESM, CJS, tsc --noEmit, bin)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
