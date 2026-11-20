// Evidence for FIX-3, FIX-4, FIX-5 (IMPLEMENTATION_PLAN.md section 13.8).
// Static checks over the repository; each includes a self-check that the scanner flags a bad case.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PKGS = join(ROOT, "packages");

interface Spec {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Every module specifier in import/export-from, side-effect import, dynamic import() and require(). */
export function specifiers(src: string): Spec[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: Spec[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(fromRe)) {
    const clause = m[3] ?? "";
    // `import { type A, type B }` is also type-only.
    const allTypeNamed = /^\{[\s\S]*\}$/.test(clause.trim()) &&
      clause.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "));
    out.push({ specifier: m[4]!, typeOnly: Boolean(m[2]) || allTypeNamed });
  }
  for (const m of code.matchAll(/\bimport\s*["']([^"']+)["']/g)) out.push({ specifier: m[1]!, typeOnly: false });
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ specifier: m[1]!, typeOnly: false });
  return out;
}

function tsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...tsFiles(p));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith(".d.ts")) files.push(p);
  }
  return files;
}

const IMPL_PKG = /^@mcp-client\/(core|transport-[^/]+|ops|auth|mrtr-cache|ext-[^/]+|telemetry-otel|conformance)(\/|$)/;

/**
 * Rule fixtures-no-impl (.dependency-cruiser.cjs "fixtures-only-core-types"): a fixtures file may
 * import node builtins, relative paths inside packages/fixtures, and @mcp-client/core as types only.
 * Anything else that names an implementation package, or a relative path leaving packages/fixtures, is a violation.
 */
export function fixturesViolations(file: string, src: string): string[] {
  const bad: string[] = [];
  const fixturesDir = join(PKGS, "fixtures");
  for (const { specifier, typeOnly } of specifiers(src)) {
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(file), specifier);
      if (!(target + sep).startsWith(fixturesDir + sep)) bad.push(`${specifier} (escapes packages/fixtures)`);
      continue;
    }
    if (/^@mcp-client\/core(\/|$)/.test(specifier)) {
      if (!typeOnly) bad.push(`${specifier} (value import of core)`);
      continue;
    }
    if (IMPL_PKG.test(specifier)) bad.push(`${specifier} (implementation package)`);
    if (/(^|\/)packages\/[^/]+\/src\//.test(specifier)) bad.push(`${specifier} (implementation source path)`);
  }
  return bad;
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

interface PkgJson {
  name: string;
  private?: boolean;
  bin?: string | Record<string, string>;
  files?: string[];
  exports?: unknown;
  main?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const packageDirs = readdirSync(PKGS).filter((d) => existsSync(join(PKGS, d, "package.json"))).sort();

function exportTargets(e: unknown): string[] {
  if (typeof e === "string") return [e];
  if (e && typeof e === "object") return Object.values(e as Record<string, unknown>).flatMap(exportTargets);
  return [];
}

describe("[FIX-3] fixtures package imports no implementation (rule fixtures-no-impl)", () => {
  const files = tsFiles(join(PKGS, "fixtures"));

  it("[FIX-3] scanner flags bad imports (self-check)", () => {
    const f = join(PKGS, "fixtures", "src", "x.ts");
    expect(fixturesViolations(f, `import { Client } from "@mcp-client/core";`)).toHaveLength(1);
    expect(fixturesViolations(f, `import { HttpTransport } from "@mcp-client/transport-http";`)).toHaveLength(1);
    expect(fixturesViolations(f, `import type { X } from "@mcp-client/ops";`)).toHaveLength(1);
    expect(fixturesViolations(f, `export * from "../../core/src/index.js";`)).toHaveLength(1);
    expect(fixturesViolations(f, `const m = await import("@mcp-client/auth");`)).toHaveLength(1);
    expect(fixturesViolations(f, `import "@mcp-client/ext-tasks";`)).toHaveLength(1);
    expect(fixturesViolations(f, `import type { Transport } from "@mcp-client/core";`)).toEqual([]);
    expect(fixturesViolations(f, `import { type A, type B } from "@mcp-client/core";`)).toEqual([]);
    expect(fixturesViolations(f, `import { join } from "node:path";\nexport * from "./schema.js";`)).toEqual([]);
  });

  it("[FIX-3] every packages/fixtures source file imports only builtins, fixtures-local paths, and core types", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.includes(`${sep}server${sep}`))).toBe(true);
    const violations = files.flatMap((f) =>
      fixturesViolations(f, readFileSync(f, "utf8")).map((v) => `${relative(ROOT, f)}: ${v}`),
    );
    expect(violations).toEqual([]);
  });

  it("[FIX-3] fixtures package.json depends on no implementation package other than core (types)", () => {
    const pkg = readJson<PkgJson>(join(PKGS, "fixtures", "package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies });
    expect(deps.filter((d) => IMPL_PKG.test(d) && d !== "@mcp-client/core")).toEqual([]);
  });

  it("[FIX-3] dependency-cruiser config carries the fixtures-only-core-types rule", () => {
    const cfg = readFileSync(join(ROOT, ".dependency-cruiser.cjs"), "utf8");
    expect(cfg).toMatch(/name:\s*"fixtures-only-core-types"[\s\S]*?from:\s*\{\s*path:\s*"\^packages\/fixtures\/"\s*\}/);
  });
});

describe("[FIX-4] synthetic server is not a shipped bin or export (audit fixtures-not-shipped)", () => {
  const fixturesPkg = readJson<PkgJson>(join(PKGS, "fixtures", "package.json"));

  function auditFixtures(pkg: PkgJson): string[] {
    const bad: string[] = [];
    if (pkg.private !== true) bad.push("not private");
    if (pkg.bin !== undefined) bad.push("has bin");
    const targets = [...exportTargets(pkg.exports), ...(pkg.main ? [pkg.main] : []), ...(pkg.files ?? [])];
    for (const t of targets) if (/(^|\/)server(\/|$)/.test(t.replace(/^\.\//, ""))) bad.push(`exposes ${t}`);
    return bad;
  }

  it("[FIX-4] audit flags a shipped server (self-check)", () => {
    expect(auditFixtures({ name: "x", private: false })).toContain("not private");
    expect(auditFixtures({ name: "x", private: true, bin: { s: "./server/http-main.js" } })).toContain("has bin");
    expect(auditFixtures({ name: "x", private: true, exports: { "./server": "./server/http-main.js" } })).toHaveLength(1);
    expect(auditFixtures({ name: "x", private: true, files: ["dist", "server"] })).toHaveLength(1);
  });

  it("[FIX-4] packages/fixtures is private, has no bin, and exports/files do not expose server/", () => {
    expect(auditFixtures(fixturesPkg)).toEqual([]);
  });

  it("[FIX-4] the fixtures build does not compile server/ into dist and index does not re-export it", () => {
    const ts = readJson<{ include?: string[]; compilerOptions?: { rootDir?: string } }>(join(PKGS, "fixtures", "tsconfig.json"));
    expect(ts.include ?? []).not.toEqual(expect.arrayContaining([expect.stringMatching(/server/)]));
    expect(ts.compilerOptions?.rootDir).toBe("src");
    const index = readFileSync(join(PKGS, "fixtures", "src", "index.ts"), "utf8");
    expect(specifiers(index).filter((s) => /server/.test(s.specifier))).toEqual([]);
  });

  it("[FIX-4] no package bin points at the synthetic server, and no publishable package depends on fixtures at runtime", () => {
    const bad: string[] = [];
    for (const d of packageDirs) {
      const pkg = readJson<PkgJson>(join(PKGS, d, "package.json"));
      const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
      for (const b of bins) if (/fixtures|server/.test(b)) bad.push(`${pkg.name} bin ${b}`);
      const runtime = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
      if (pkg.private !== true && "@mcp-client/fixtures" in runtime) bad.push(`${pkg.name} (publishable) depends on fixtures`);
    }
    expect(packageDirs.length).toBeGreaterThan(1);
    expect(bad).toEqual([]);
  });
});

describe("[FIX-5] official runner is a subprocess only (static grep no-runner-import)", () => {
  const map = readJson<Record<string, unknown> & { runner: Record<string, unknown> }>(join(PKGS, "conformance", "official-map.json"));
  const runnerPkg = String(map.runner.package);

  function runnerImports(src: string, name: string): string[] {
    return specifiers(src).map((s) => s.specifier).filter((s) => s === name || s.startsWith(`${name}/`));
  }

  it("[FIX-5] grep flags a runner import (self-check)", () => {
    expect(runnerImports(`import { run } from "${runnerPkg}";`, runnerPkg)).toHaveLength(1);
    expect(runnerImports(`const r = require("${runnerPkg}/dist/index.js");`, runnerPkg)).toHaveLength(1);
    expect(runnerImports(`await import("${runnerPkg}")`, runnerPkg)).toHaveLength(1);
    expect(runnerImports(`spawnSync(process.execPath, [bin])`, runnerPkg)).toEqual([]);
  });

  it("[FIX-5] no file under packages/*/src imports the official runner package", () => {
    expect(runnerPkg).toMatch(/conformance/);
    const bad: string[] = [];
    for (const d of packageDirs) {
      for (const f of tsFiles(join(PKGS, d, "src"))) {
        for (const s of runnerImports(readFileSync(f, "utf8"), runnerPkg)) bad.push(`${relative(ROOT, f)}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
    // Nor is it a declared dependency of any package.
    for (const d of packageDirs) {
      const pkg = readJson<Record<string, Record<string, string> | undefined>>(join(PKGS, d, "package.json"));
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys(pkg[k] ?? {}), `${d} ${k}`).not.toContain(runnerPkg);
      }
    }
  });

  it("[FIX-5] official.ts launches the runner through child_process", () => {
    const src = readFileSync(join(PKGS, "conformance", "src", "official.ts"), "utf8");
    expect(specifiers(src).map((s) => s.specifier)).toContain("node:child_process");
    expect(src).toMatch(/\b(spawn|spawnSync|execFile|execFileSync)\(\s*process\.execPath,\s*\[\s*bin\b/);
  });

  it("[FIX-5] official-map.json parses and carries every field loadOfficialMap callers require", () => {
    for (const k of ["runner", "targetSpecVersion", "cut", "catalog", "resultSchema", "eligibility", "scenarios", "legacy"]) {
      expect(map, k).toHaveProperty(k);
    }
    for (const k of ["repository", "package", "version", "tag", "commit", "source", "checkoutDir"]) {
      expect(typeof map.runner[k], `runner.${k}`).toBe("string");
    }
    expect(map.runner.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Array.isArray(map.runner.clientArgs)).toBe(true);
    const cut = map.cut as Record<string, unknown>;
    expect(typeof cut.authorized).toBe("boolean");
    expect(typeof cut.reason).toBe("string");
    const catalog = map.catalog as Record<string, unknown>;
    expect(typeof catalog.selected).toBe("boolean");
    expect(typeof catalog.reason).toBe("string");
    const rs = map.resultSchema as Record<string, unknown> | null;
    if (rs === null) expect(typeof map.resultSchemaReason).toBe("string");
    else expect(rs).toMatchObject({
      source: expect.any(String),
      passedField: "passed",
      failedField: "failed",
      totalField: "total",
      notScoredField: "not_scored",
    });
    const el = map.eligibility as { specVersion: unknown; requires: Record<string, unknown> };
    expect(el.specVersion).toBe(map.targetSpecVersion);
    for (const f of ["legacy", "experimental", "extension", "disputed"]) expect(typeof el.requires[f], f).toBe("boolean");
    for (const list of [map.scenarios, map.legacy] as unknown[]) {
      expect(Array.isArray(list)).toBe(true);
      for (const s of list as Record<string, unknown>[]) {
        expect(typeof s.id).toBe("string");
        expect(s.specVersion === null || typeof s.specVersion === "string").toBe(true);
        expect(Array.isArray(s.requirements)).toBe(true);
      }
    }
  });
});
