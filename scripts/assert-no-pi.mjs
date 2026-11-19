#!/usr/bin/env node
// §14.2 fresh-process isolation ("no Pi packages").
//
// Usage:
//   node scripts/assert-no-pi.mjs [--root <dir>] [--deny <file>]               static scans only
//   node scripts/assert-no-pi.mjs [--root <dir>] [--deny <file>] -- <node-args>  scans, then run node
//
// Static scans: gate-process environment (no PI_*, NODE_PATH unset, XDG_* empty),
// <root>/package-lock.json and <root>/node_modules/**/package.json against deny-pi.json.
// Protected run: spawns `node <node-args>` with a preload (this file) that installs a
// module resolution hook which records and throws on any denied specifier or on any
// module loaded from <root>/adapters/. Each hit is appended to a violations file owned
// by the wrapper, so the gate fails even if the child catches the import error.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), "..");
const PRELOAD_ENV = "ASSERT_NO_PI_VIOLATIONS";
const DENY_ENV = "ASSERT_NO_PI_DENY";
const ADAPTERS_ENV = "ASSERT_NO_PI_ADAPTERS";

export function makeMatcher(deny) {
  const packages = deny.packages ?? [];
  const prefixes = deny.prefixes ?? [];
  const substrings = deny.substrings ?? [];
  return (name) => {
    if (typeof name !== "string" || name.length === 0) return null;
    for (const p of packages) if (name === p || name.startsWith(p + "/")) return `package ${p}`;
    for (const p of prefixes) if (name.startsWith(p)) return `prefix ${p}`;
    for (const s of substrings) if (name.includes(s)) return `substring ${s}`;
    return null;
  };
}

// ---------- preload mode: runs inside the protected child ----------
async function installHook() {
  const violations = process.env[PRELOAD_ENV];
  const deny = JSON.parse(process.env[DENY_ENV] ?? "{}");
  const adapters = process.env[ADAPTERS_ENV];
  const adaptersUrl = adapters ? pathToFileURL(adapters).href + "/" : null;
  const denied = makeMatcher(deny);
  const report = (what, why) => {
    try { appendFileSync(violations, `${what}\t${why}\n`); } catch {}
    const err = new Error(`assert-no-pi: denied module resolution: ${what} (${why})`);
    err.code = "ERR_ASSERT_NO_PI";
    return err;
  };
  const check = (specifier, url) => {
    const bySpec = denied(specifier);
    if (bySpec) throw report(specifier, bySpec);
    if (url) {
      const byUrl = denied(decodeURIComponent(url));
      if (byUrl) throw report(url, byUrl);
      if (adaptersUrl && url.startsWith(adaptersUrl)) throw report(url, "adapter code");
    }
  };
  const mod = await import("node:module");
  if (typeof mod.registerHooks === "function") {
    mod.registerHooks({
      resolve(specifier, context, next) {
        check(specifier, null);
        const result = next(specifier, context);
        check(specifier, result.url);
        return result;
      },
    });
  } else {
    const src = `
      const denyJson = ${JSON.stringify(JSON.stringify(deny))};
      import { appendFileSync } from "node:fs";
      const make = ${makeMatcher.toString()};
      const denied = make(JSON.parse(denyJson));
      const violations = ${JSON.stringify(violations)};
      const adaptersUrl = ${JSON.stringify(adaptersUrl)};
      const report = (what, why) => { try { appendFileSync(violations, what + "\\t" + why + "\\n"); } catch {}
        return new Error("assert-no-pi: denied module resolution: " + what + " (" + why + ")"); };
      export async function resolve(specifier, context, next) {
        let why = denied(specifier); if (why) throw report(specifier, why);
        const r = await next(specifier, context);
        why = denied(decodeURIComponent(r.url)); if (why) throw report(r.url, why);
        if (adaptersUrl && r.url.startsWith(adaptersUrl)) throw report(r.url, "adapter code");
        return r;
      }`;
    mod.register("data:text/javascript," + encodeURIComponent(src));
  }
}

// ---------- static scans ----------
function scanEnv(env) {
  const errs = [];
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("PI_")) errs.push(`PI_* environment variable set in gate process: ${k}`);
    if (k.startsWith("XDG_") && v) errs.push(`XDG_* must be empty in gate process: ${k}`);
  }
  if (env.NODE_PATH !== undefined) errs.push("NODE_PATH must be unset in gate process");
  return errs;
}

function scanLockfile(root, denied) {
  const file = join(root, "package-lock.json");
  if (!existsSync(file)) return [];
  const lock = JSON.parse(readFileSync(file, "utf8"));
  const errs = [];
  const hit = (name, where) => {
    const why = denied(name);
    if (why) errs.push(`package-lock.json: ${where} matches denied ${why}`);
  };
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const idx = key.lastIndexOf("node_modules/");
    if (idx >= 0) hit(key.slice(idx + "node_modules/".length), key);
    if (entry?.name) hit(entry.name, `${key || "<root>"} name`);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dep of Object.keys(entry?.[field] ?? {})) hit(dep, `${key || "<root>"} ${field}`);
    }
  }
  const walkV1 = (deps, path) => {
    for (const [name, entry] of Object.entries(deps ?? {})) {
      hit(name, `${path}${name}`);
      walkV1(entry?.dependencies, `${path}${name}>`);
    }
  };
  walkV1(lock.dependencies, "dependencies:");
  return errs;
}

function scanNodeModules(root, denied) {
  const errs = [];
  const seen = new Set();
  const checkPkg = (dir, rel) => {
    const pj = join(dir, "package.json");
    let name = rel;
    try { name = JSON.parse(readFileSync(pj, "utf8")).name ?? rel; } catch {}
    for (const n of new Set([rel, name])) {
      const why = denied(n);
      if (why) errs.push(`node_modules: ${dir} (${n}) matches denied ${why}`);
    }
  };
  const walk = (nm) => {
    if (seen.has(nm) || !existsSync(nm)) return;
    seen.add(nm);
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith(".")) continue;
      const p = join(nm, entry);
      if (entry.startsWith("@")) {
        let scoped = [];
        try { scoped = readdirSync(p); } catch { continue; }
        for (const s of scoped) visit(join(p, s), `${entry}/${s}`);
      } else visit(p, entry);
    }
  };
  const visit = (dir, rel) => {
    checkPkg(dir, rel);
    let st;
    try { st = lstatSync(dir); } catch { return; }
    if (st.isDirectory() && !st.isSymbolicLink()) walk(join(dir, "node_modules"));
  };
  walk(join(root, "node_modules"));
  return errs;
}

// ---------- CLI ----------
function parseArgs(argv) {
  const opts = { root: ROOT, deny: null, nodeArgs: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { opts.nodeArgs = argv.slice(i + 1); break; }
    else if (a === "--root") opts.root = resolve(argv[++i]);
    else if (a === "--deny") opts.deny = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  opts.deny ??= join(ROOT, "packages/conformance/deny-pi.json");
  return opts;
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(`assert-no-pi: ${e.message}`); return 2; }
  const deny = JSON.parse(readFileSync(opts.deny, "utf8"));
  if (!deny.packages?.length && !deny.prefixes?.length && !deny.substrings?.length) {
    console.error("assert-no-pi: deny-pi.json is empty");
    return 1;
  }
  const denied = makeMatcher(deny);
  const errs = [...scanEnv(process.env), ...scanLockfile(opts.root, denied), ...scanNodeModules(opts.root, denied)];
  if (errs.length) {
    for (const e of errs) console.error(`assert-no-pi: ${e}`);
    return 1;
  }
  if (!opts.nodeArgs) { console.log("assert-no-pi: ok"); return 0; }
  if (opts.nodeArgs.length === 0) { console.error("assert-no-pi: no node arguments after --"); return 2; }

  const dir = mkdtempSync(join(tmpdir(), "assert-no-pi-"));
  const violations = join(dir, "violations.log");
  try {
    const preload = `--import=${pathToFileURL(SELF).href}`;
    const env = {
      ...process.env,
      [PRELOAD_ENV]: violations,
      [DENY_ENV]: JSON.stringify(deny),
      [ADAPTERS_ENV]: join(opts.root, "adapters"),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    };
    const child = spawnSync(process.execPath, opts.nodeArgs, { stdio: "inherit", env });
    if (child.error) { console.error(`assert-no-pi: spawn failed: ${child.error.message}`); return 1; }
    const hits = existsSync(violations) ? readFileSync(violations, "utf8").split("\n").filter(Boolean) : [];
    if (hits.length) {
      for (const h of hits) console.error(`assert-no-pi: denied resolution in gate process: ${h}`);
      return 1;
    }
    if (child.signal) { console.error(`assert-no-pi: child killed by ${child.signal}`); return 1; }
    return child.status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.env[PRELOAD_ENV] && process.argv[1] !== SELF) {
  await installHook();
} else if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
