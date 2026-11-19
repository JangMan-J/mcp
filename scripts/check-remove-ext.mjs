#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = process.argv[2];
if (!extDir) { console.error("usage: check-remove-ext.mjs <ext-dir>"); process.exit(2); }
if (!/^ext-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(extDir)) {
  console.error(`check-remove-ext: invalid extension dir '${extDir}' (expected ext-<name> under packages/)`); process.exit(2);
}
if (!existsSync(join(root, "packages", extDir, "package.json"))) {
  console.error(`check-remove-ext: packages/${extDir}/package.json not found`); process.exit(2);
}

const KNOWN = {
  "ext-client-credentials": { extensionId: "io.modelcontextprotocol/oauth-client-credentials", subdir: "ext/cc", area: "ext:cc" },
  "ext-enterprise-auth": { extensionId: "io.modelcontextprotocol/enterprise-managed-authorization", subdir: "ext/ema", area: "ext:ema" },
  "ext-tasks": { extensionId: "io.modelcontextprotocol/tasks", subdir: "ext/tasks", area: "ext:tasks", ownedResultType: "task" },
  "ext-skills": { extensionId: "io.modelcontextprotocol/skills", subdir: "ext/skills", area: "ext:skills" },
  "ext-apps": { extensionId: "io.modelcontextprotocol/ui", subdir: "ext/apps", area: "ext:apps" },
  "ext-server-cards": { extensionId: "io.modelcontextprotocol/server-card", subdir: "ext/card", area: "ext:card" },
  // ext/events is shared: ext-events owns only its top-level fixtures; ext/events/webhook belongs to ext-events-webhook.
  "ext-events": { extensionId: "io.modelcontextprotocol/events", subdir: "ext/events", area: "ext:events", shallow: true },
  "ext-events-webhook": { extensionId: "io.modelcontextprotocol/events-webhook", subdir: "ext/events/webhook", area: "ext:events:webhook" },
};

// Optional areas checked after removal. `runner` areas are routed by the conformance CLI;
// the rest are run directly through the owning package's ./conformance export.
// `shallow` areas own only the *.exchange.json files directly in `dir` (not subdirectories).
const OPTIONAL = [
  { area: "ext:cc", dir: "ext/cc", runner: true },
  { area: "ext:ema", dir: "ext/ema", runner: true },
  { area: "ext:tasks", dir: "ext/tasks", runner: true },
  { area: "ext:skills", dir: "ext/skills", runner: true },
  { area: "tel", dir: "tel", runner: true },
  { area: "ext:apps", dir: "ext/apps", pkg: "ext-apps" },
  { area: "ext:card", dir: "ext/card", pkg: "ext-server-cards" },
  { area: "ext:events", dir: "ext/events", pkg: "ext-events", shallow: true },
  { area: "ext:events:webhook", dir: "ext/events/webhook", pkg: "ext-events-webhook" },
];

const fixtureFiles = (dir, shallow) => {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!shallow) out.push(...fixtureFiles(p, false)); }
    else if (e.name.endsWith(".exchange.json")) out.push(p);
  }
  return out.sort();
};

function derive() {
  if (KNOWN[extDir]) return KNOWN[extDir];
  const short = extDir.replace(/^ext-/, "");
  let extensionId = `io.modelcontextprotocol/${short}`;
  // Try to find an extension id literal in the package sources.
  const pkgDir = join(root, "packages", extDir);
  try {
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|js|mjs|json)$/.test(e.name)) { const m = readFileSync(p, "utf8").match(/io\.modelcontextprotocol\/[A-Za-z0-9._-]+/); if (m) throw { id: m[0] }; } } };
    walk(pkgDir);
  } catch (e) { if (e && e.id) extensionId = e.id; }
  return { extensionId, subdir: `ext/${short}`, area: `ext:${short}` };
}
const info = derive();
const CORE_AREA = "wire,ver,prog,smoke,ops,auth,consent,mrtr,elic,sub,cache";

function runConformance(cwd, area) {
  const cli = join(cwd, "packages/conformance/dist/cli.js");
  const out = execFileSync(process.execPath, [cli, "run", "--tier", "A", "--area", area, "--json"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

let scratch;
try {
  // Build the checkout first so a fresh export (no dist/) can run the baseline.
  execFileSync(process.execPath, [join(root, "scripts/build-workspaces.mjs")], { cwd: root, stdio: "pipe" });
  const baseline = runConformance(root, CORE_AREA);
  if (!baseline.ok) throw new Error(`baseline core conformance failed: ${JSON.stringify(baseline.results?.filter(r=>!r.ok))}`);

  scratch = mkdtempSync(join(tmpdir(), "check-remove-ext-"));
  // Copy needed trees.
  cpSync(join(root, "packages"), join(scratch, "packages"), { recursive: true });
  cpSync(join(root, "scripts"), join(scratch, "scripts"), { recursive: true });
  for (const f of readdirSync(root)) if (/^tsconfig.*\.json$/.test(f) || f === "package.json" || f === ".dependency-cruiser.cjs") cpSync(join(root, f), join(scratch, f));
  // node_modules: symlink non-@mcp-client entries, real dir for @mcp-client
  const nm = join(scratch, "node_modules");
  mkdirSync(join(nm, "@mcp-client"), { recursive: true });
  const srcNm = join(root, "node_modules");
  if (existsSync(srcNm)) {
    for (const e of readdirSync(srcNm, { withFileTypes: true })) {
      if (e.name === "@mcp-client") continue;
      try { symlinkSync(join(srcNm, e.name), join(nm, e.name), e.isDirectory() ? "dir" : "file"); } catch {}
    }
  }
  // Delete extension + fixtures
  rmSync(join(scratch, "packages", extDir), { recursive: true, force: true });
  const fxDir = join(scratch, "packages/fixtures/exchanges", info.subdir);
  if (info.shallow) { for (const f of fixtureFiles(fxDir, true)) rmSync(f, { force: true }); }
  else rmSync(fxDir, { recursive: true, force: true });
  // Shared subtree guard: removing ext-events must leave the webhook fixtures in place.
  if (info.shallow) {
    const before = fixtureFiles(join(root, "packages/fixtures/exchanges", info.subdir), false).length - fixtureFiles(join(root, "packages/fixtures/exchanges", info.subdir), true).length;
    const kept = fixtureFiles(fxDir, false).length;
    if (kept !== before) throw new Error(`removal of ${extDir} touched nested fixtures under ${info.subdir} (${kept}/${before} kept)`);
  }

  // Rebuild in scratch (removes stale link)
  execFileSync(process.execPath, [join(scratch, "scripts/build-workspaces.mjs")], { cwd: scratch, stdio: "inherit" });

  const after = runConformance(scratch, CORE_AREA);
  if (JSON.stringify(after.results) !== JSON.stringify(baseline.results)) {
    throw new Error("EXT-REMOVE-1: core fixture results differ after removal");
  }
  if (!after.ok) throw new Error("core conformance failed after removal");

  // Other present optional areas
  const exRoot = join(scratch, "packages/fixtures/exchanges");
  const directProbe = join(scratch, "remove-area-probe.mjs");
  writeFileSync(directProbe, `
const [spec, ...files] = process.argv.slice(2);
const { readFileSync } = await import("node:fs");
const { runExchange } = await import(spec);
for (const f of files) await runExchange(JSON.parse(readFileSync(f, "utf8")));
console.log("area ok " + files.length);
`);
  for (const opt of OPTIONAL) {
    if (opt.area === info.area) continue;
    const files = fixtureFiles(join(exRoot, opt.dir), opt.shallow);
    if (files.length === 0) continue;
    if (opt.runner) {
      const s = runConformance(scratch, opt.area);
      if (!s.ok || s.passed <= 0) throw new Error(`optional area ${opt.area} failed after removal of ${extDir}`);
      continue;
    }
    if (!existsSync(join(scratch, "packages", opt.pkg))) throw new Error(`optional area ${opt.area} has fixtures but packages/${opt.pkg} is missing`);
    try {
      execFileSync(process.execPath, [directProbe, `@mcp-client/${opt.pkg}/conformance`, ...files], { cwd: scratch, stdio: "pipe", encoding: "utf8" });
    } catch (e) {
      throw new Error(`optional area ${opt.area} failed after removal of ${extDir}: ${e.stderr || e.message}`);
    }
  }

  // Probe McpClient capabilities / protocol-violation via a probe file inside scratch so @mcp-client/core resolves there.
  const probePath = join(scratch, "remove-probe.mjs");
  writeFileSync(probePath, `
import { McpClient } from "@mcp-client/core";
const extensionId = process.env.REMOVE_EXT_ID;
const owned = process.env.REMOVE_OWNED || "";
let resolver; let sent = [];
const empty = { async *[Symbol.asyncIterator]() {} };
const transport = {
  binding: "stdio",
  start(msg) { sent.push(msg); return { notifications: empty, done: new Promise(r => { resolver = r; }) }; },
  async notify() {}, async close() {}, diagnostics: empty,
};
const client = new McpClient({ transport, server: { key: "remove-check" } });
let handle = client.request("tools/list", {});
await new Promise(r => setImmediate(r));
resolver({ kind: "response", message: { jsonrpc: "2.0", id: sent[0].id, result: { resultType: "complete" } } });
const outcome = await handle;
const caps = sent[0]?.params?._meta?.["io.modelcontextprotocol/clientCapabilities"];
if (JSON.stringify(caps ?? {}).includes(extensionId)) throw new Error("capabilities contain removed extension");
if (JSON.stringify(sent).includes(extensionId)) throw new Error("wire contains removed extension id");
if (owned === "task") {
  sent = [];
  let h2 = client.request("tools/list", {});
  await new Promise(r => setImmediate(r));
  resolver({ kind: "response", message: { jsonrpc: "2.0", id: sent[0].id, result: { resultType: "task", taskId: "t1", status: "working" } } });
  const o2 = await h2;
  if (o2.kind !== "protocol-violation") throw new Error("expected protocol-violation for task result, got " + o2.kind);
}
await client.close();
console.log("probe ok");
`);
  execFileSync(process.execPath, [probePath], { cwd: scratch, stdio: "inherit", env: { ...process.env, REMOVE_EXT_ID: info.extensionId, REMOVE_OWNED: info.ownedResultType ?? "" } });

  console.log(`check-remove-ext: ok (${extDir})`);
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
