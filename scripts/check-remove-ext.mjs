#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extDir = process.argv[2];
if (!extDir) { console.error("usage: check-remove-ext.mjs <ext-dir>"); process.exit(2); }

const KNOWN = {
  "ext-client-credentials": { extensionId: "io.modelcontextprotocol/oauth-client-credentials", subdir: "ext/cc", area: "ext:cc" },
  "ext-enterprise-auth": { extensionId: "io.modelcontextprotocol/enterprise-managed-authorization", subdir: "ext/ema", area: "ext:ema" },
  "ext-tasks": { extensionId: "io.modelcontextprotocol/tasks", subdir: "ext/tasks", area: "ext:tasks", ownedResultType: "task" },
  "ext-skills": { extensionId: "io.modelcontextprotocol/skills", subdir: "ext/skills", area: "ext:skills" },
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
  rmSync(join(scratch, "packages/fixtures/exchanges", info.subdir), { recursive: true, force: true });

  // Rebuild in scratch (removes stale link)
  execFileSync(process.execPath, [join(scratch, "scripts/build-workspaces.mjs")], { cwd: scratch, stdio: "inherit" });
  if (existsSync(join(scratch, "node_modules/@mcp-client", extDir.replace(/^@mcp-client\//,"")))) {
    // build-workspaces keys by package short name which equals extDir for known exts; for safety check link existence by ext short
  }

  const after = runConformance(scratch, CORE_AREA);
  if (JSON.stringify(after.results) !== JSON.stringify(baseline.results)) {
    throw new Error("EXT-REMOVE-1: core fixture results differ after removal");
  }
  if (!after.ok) throw new Error("core conformance failed after removal");

  // Other present optional areas
  const areas = [];
  const exRoot = join(scratch, "packages/fixtures/exchanges");
  const checkDir = (rel, area) => { if (existsSync(join(exRoot, rel))) areas.push(area); };
  checkDir("ext/cc", "ext:cc"); checkDir("ext/ema", "ext:ema"); checkDir("ext/tasks", "ext:tasks"); checkDir("ext/skills", "ext:skills"); checkDir("tel", "tel");
  for (const area of areas) {
    if (area === info.area) continue;
    const s = runConformance(scratch, area);
    if (!s.ok || s.passed <= 0) throw new Error(`optional area ${area} failed after removal of ${extDir}`);
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
