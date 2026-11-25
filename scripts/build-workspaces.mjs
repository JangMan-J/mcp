#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const linkDir = join(root, "node_modules", "@mcp-client");
mkdirSync(linkDir, { recursive: true });

const present = new Map(); // shortName -> dirName
for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgFile = join(packagesDir, entry.name, "package.json");
  if (!existsSync(pkgFile)) continue;
  try {
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    if (typeof pkg.name === "string" && pkg.name.startsWith("@mcp-client/")) {
      present.set(pkg.name.slice("@mcp-client/".length), entry.name);
    }
  } catch {}
}

// Remove stale/dangling links and ensure correct relative links.
for (const entry of readdirSync(linkDir, { withFileTypes: true })) {
  const p = join(linkDir, entry.name);
  const dirName = present.get(entry.name);
  if (!dirName) {
    // Remove stale symlink (or stale entry) whose package was deleted.
    try { if (lstatSync(p).isSymbolicLink() || entry.isSymbolicLink()) rmSync(p, { recursive: true, force: true }); } catch {}
    continue;
  }
  const target = `../../packages/${dirName}`;
  let ok = false;
  try {
    if (lstatSync(p).isSymbolicLink()) {
      // readlink check via realpath resolving to expected dir
      ok = realpathSync(p) === realpathSync(join(packagesDir, dirName));
    }
  } catch {}
  if (!ok) {
    rmSync(p, { recursive: true, force: true });
    symlinkSync(target, p, "dir");
  }
}
for (const [short, dirName] of present) {
  const p = join(linkDir, short);
  if (!existsSync(p)) symlinkSync(`../../packages/${dirName}`, p, "dir");
}

// Verify checkout-local.
for (const entry of readdirSync(linkDir)) {
  const p = join(linkDir, entry);
  let real;
  try { real = realpathSync(p); } catch { throw new Error(`build-workspaces: dangling @mcp-client link ${entry}`); }
  const rel = relative(packagesDir, real);
  if (rel.startsWith("..") || resolve(packagesDir, rel) !== real && rel === "") {}
  if (rel.startsWith("..")) throw new Error(`build-workspaces: @mcp-client/${entry} resolves outside packages/: ${real}`);
}

// Clean workspace dist/ and incremental tsbuildinfo before tsc -b so removed/renamed files never linger.
for (const dirName of [...present.values()].sort()) {
  rmSync(join(packagesDir, dirName, "dist"), { recursive: true, force: true });
  rmSync(join(packagesDir, dirName, "tsconfig.tsbuildinfo"), { force: true });
}

// Run tsc -b
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const tscArgs = existsSync(tscBin) ? [tscBin] : null;
function runTsc(args) {
  if (tscArgs) execFileSync(process.execPath, [...tscArgs, ...args], { cwd: root, stdio: "inherit" });
  else execFileSync(join(root, "node_modules", ".bin", "tsc"), args, { cwd: root, stdio: "inherit" });
}
runTsc(["-b", join(root, "tsconfig.json")]);

let rootRefs = new Set();
try {
  const cfg = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  for (const r of cfg.references ?? []) rootRefs.add(resolve(root, r.path));
} catch {}
for (const dirName of [...present.values()].sort()) {
  const dir = join(packagesDir, dirName);
  const ts = join(dir, "tsconfig.json");
  if (existsSync(ts) && !rootRefs.has(dir) && !rootRefs.has(ts)) {
    runTsc(["-b", ts]);
  }
}

// Assemble unified dist/ at repo root for @jangmanj/mcp (omitting *.map and sourceMappingURL hints).
const distRoot = join(root, "dist");
rmSync(distRoot, { recursive: true, force: true });
mkdirSync(distRoot, { recursive: true });

for (const dirName of [...present.values()].sort()) {
  const srcDist = join(packagesDir, dirName, "dist");
  if (!existsSync(srcDist)) continue;
  cpSync(srcDist, join(distRoot, dirName), {
    recursive: true,
    filter: (src) => !src.endsWith(".map"),
  });
}

function rewriteDistImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDistImports(full);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    const text = readFileSync(full, "utf8");
    let replaced = text.replace(
      /(["'])@mcp-client\/([a-z0-9-]+)\1/g,
      (match, quote, short) => {
        const targetDir = present.get(short);
        if (!targetDir) return match;
        const fromDir = dirname(full).split("\\").join("/");
        const targetFile = join(distRoot, targetDir, "index.js").split("\\").join("/");
        let rel = posix.relative(fromDir, targetFile);
        if (!rel.startsWith(".")) rel = `./${rel}`;
        return `${quote}${rel}${quote}`;
      }
    );
    replaced = replaced.replace(/\r?\n?\/\/# sourceMappingURL=[^\r\n]*\r?\n?$/g, (m) => (m.startsWith("\n") || m.startsWith("\r") ? "\n" : ""));
    if (replaced !== text) writeFileSync(full, replaced);
  }
}

function assertNoUnrewrittenWorkspaceSpecifiers(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoUnrewrittenWorkspaceSpecifiers(full);
      continue;
    }
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;
    const text = readFileSync(full, "utf8");
    const m = text.match(/(["'])@mcp-client\/[^"']+\1/);
    if (m) {
      throw new Error(`build-workspaces: unrewritten workspace specifier ${m[0]} in ${full}`);
    }
  }
}

rewriteDistImports(distRoot);
writeFileSync(join(distRoot, "index.js"), 'export * from "./core/index.js";\n');
writeFileSync(join(distRoot, "index.d.ts"), 'export * from "./core/index.js";\n');
assertNoUnrewrittenWorkspaceSpecifiers(distRoot);

console.log("build-workspaces: ok");
