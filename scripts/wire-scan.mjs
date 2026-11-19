#!/usr/bin/env node
// wire-scan: GATE-4 / G11. Scans recorded wire transcripts for forbidden client constructs (PLAN N7/N8).
// Usage: node scripts/wire-scan.mjs <file-or-dir>...
//
// Input: JSON files
//   { fixture: string, incomplete?: false, mcpEndpoint?: string,
//     frames: [{ direction: "client"|"server", endpoint?: "mcp"|"oauth"|"registration"|"other",
//                message?: JSON-RPC, method?: HTTP method, headers?: object, url?: string, incomplete?: false }] }
//
// Rules:
// - Only client frames are judged; server frames are deliberate stimuli and never flagged (shape still validated).
// - `incomplete` (transcript or frame) that is not `false` is an error: partial evidence never yields a clean result.
// - Endpoint class per frame: explicit `endpoint`, else "mcp" when url matches `mcpEndpoint` or a JSON-RPC
//   `message` is present. A client HTTP observation (method/url/headers) with no resolvable class is an error.
// - POST-only applies to MCP endpoint frames only (OAuth discovery/authorize legitimately use GET).
// - Mcp-Session-Id / Last-Event-ID headers are forbidden on any client frame.
// - URL leakage: credential query params (access_token, refresh_token, id_token, client_secret) or userinfo in any
//   client URL are violations.
// - DCR (excluded, N8): any client frame tagged endpoint "registration" is a violation, authenticated or not.
//   LIMITATION: frames carry no request body, so DCR is only detected through the `registration` tag; a
//   registration request tagged "oauth"/"other" is not detected. The clean summary repeats this limitation.
// - logLevel is checked only as a key of params._meta; includeContext only as a top-level params key.
//   Tool arguments and other payload content are never inspected.
// Header values, query values and URL credentials are never printed, only names.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "logging/setLevel",
  "notifications/message",
  "roots/list",
  "notifications/roots/list_changed",
  "sampling/createMessage",
  "resources/subscribe",
  "resources/unsubscribe",
  "notifications/elicitation/complete",
]);
export const FORBIDDEN_HEADERS = new Set(["mcp-session-id", "last-event-id"]);
export const LEAKY_QUERY_PARAMS = new Set(["access_token", "refresh_token", "id_token", "client_secret"]);
export const ENDPOINTS = new Set(["mcp", "oauth", "registration", "other"]);
export const DCR_LIMITATION =
  "DCR detection relies on endpoint:'registration' metadata; untagged or mis-tagged registration requests are not detected";
const LOG_LEVEL_META = "io.modelcontextprotocol/logLevel";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function sameEndpoint(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function classify(frame, mcpEndpoint) {
  if (frame.endpoint !== undefined) return frame.endpoint;
  if (mcpEndpoint && typeof frame.url === "string" && sameEndpoint(frame.url, mcpEndpoint)) return "mcp";
  if (frame.message !== undefined) return "mcp";
  return null;
}

function scanMessage(msg) {
  const out = [];
  if (Array.isArray(msg)) return ["JSON-RPC batch sent"];
  if (!isObj(msg)) return ["message is not a JSON object"];
  if (typeof msg.method === "string" && FORBIDDEN_METHODS.has(msg.method)) out.push(`forbidden method '${msg.method}'`);
  if (isObj(msg.params)) {
    if (Object.hasOwn(msg.params, "includeContext")) out.push("forbidden param 'includeContext'");
    if (isObj(msg.params._meta) && Object.hasOwn(msg.params._meta, LOG_LEVEL_META)) {
      out.push(`forbidden meta key '${LOG_LEVEL_META}'`);
    }
  }
  return out;
}

function scanUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return ["url is not a valid absolute URL"];
  }
  const out = [];
  if (u.username || u.password) out.push("credentials in URL userinfo");
  const seen = new Set();
  for (const key of u.searchParams.keys()) {
    const k = key.toLowerCase();
    if (LEAKY_QUERY_PARAMS.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(`credential query parameter '${key}' in URL`);
    }
  }
  return out;
}

function scanClientFrame(frame, endpoint) {
  const out = [];
  if (endpoint === "registration") out.push("Dynamic Client Registration request (excluded)");
  if (frame.message !== undefined) out.push(...scanMessage(frame.message));
  if (frame.method !== undefined && endpoint === "mcp") {
    const m = frame.method.toUpperCase();
    if (m !== "POST") out.push(`forbidden HTTP method '${m}' on MCP endpoint`);
  }
  if (frame.headers !== undefined) {
    for (const name of Object.keys(frame.headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) out.push(`forbidden header '${name}'`);
    }
  }
  if (frame.url !== undefined) out.push(...scanUrl(frame.url));
  return out;
}

function validateFrame(frame) {
  if (!isObj(frame)) return "frame is not an object";
  if (frame.direction !== "client" && frame.direction !== "server") return "frame.direction must be 'client' or 'server'";
  if (frame.incomplete !== undefined && frame.incomplete !== false) return "frame marked incomplete";
  if (frame.message === undefined && frame.method === undefined && frame.headers === undefined && frame.url === undefined) {
    return "frame carries no evidence (message/method/headers/url)";
  }
  if (frame.endpoint !== undefined && !ENDPOINTS.has(frame.endpoint)) {
    return `frame.endpoint must be one of ${[...ENDPOINTS].join(", ")}`;
  }
  if (frame.method !== undefined && (typeof frame.method !== "string" || frame.method.length === 0)) {
    return "frame.method must be a non-empty string";
  }
  if (frame.headers !== undefined && !isObj(frame.headers)) return "frame.headers must be an object";
  if (frame.url !== undefined && typeof frame.url !== "string") return "frame.url must be a string";
  return null;
}

/** Scan one parsed transcript. Returns { errors, violations, clientFrames }. */
export function scanTranscript(doc, label = "<input>") {
  const errors = [];
  const violations = [];
  let clientFrames = 0;
  if (!isObj(doc)) return { errors: [`${label}: transcript is not a JSON object`], violations, clientFrames };
  if (typeof doc.fixture !== "string" || doc.fixture.length === 0) errors.push(`${label}: missing 'fixture' string`);
  if (doc.incomplete !== undefined && doc.incomplete !== false) errors.push(`${label}: transcript marked incomplete`);
  if (doc.mcpEndpoint !== undefined && typeof doc.mcpEndpoint !== "string") {
    errors.push(`${label}: 'mcpEndpoint' must be a string`);
  }
  if (!Array.isArray(doc.frames)) {
    errors.push(`${label}: missing 'frames' array`);
    return { errors, violations, clientFrames };
  }
  if (doc.frames.length === 0) errors.push(`${label}: empty 'frames' (no evidence)`);
  const name = typeof doc.fixture === "string" ? doc.fixture : "?";
  const mcpEndpoint = typeof doc.mcpEndpoint === "string" ? doc.mcpEndpoint : undefined;
  doc.frames.forEach((frame, i) => {
    const bad = validateFrame(frame);
    if (bad) {
      errors.push(`${label}: frame ${i}: ${bad}`);
      return;
    }
    if (frame.direction !== "client") return;
    const endpoint = classify(frame, mcpEndpoint);
    if (endpoint === null) {
      errors.push(`${label}: frame ${i}: cannot classify client HTTP frame; set 'endpoint' or transcript 'mcpEndpoint'`);
      return;
    }
    clientFrames++;
    for (const v of scanClientFrame(frame, endpoint)) violations.push(`${label} [${name}] frame ${i}: ${v}`);
  });
  return { errors, violations, clientFrames };
}

function collectFiles(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) collectFiles(join(p, e), out);
  } else if (p.endsWith(".json")) {
    out.push(p);
  }
}

/** Scan paths (files or directories). Returns { errors, violations, files, clientFrames }. */
export function scanPaths(paths) {
  const errors = [];
  const violations = [];
  const files = [];
  let clientFrames = 0;
  if (paths.length === 0) errors.push("no input paths given");
  for (const p of paths) {
    try {
      collectFiles(resolve(p), files);
    } catch {
      errors.push(`${p}: not found`);
    }
  }
  if (paths.length > 0 && files.length === 0 && errors.length === 0) errors.push("no transcript files found (no evidence)");
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      errors.push(`${f}: invalid JSON`);
      continue;
    }
    const r = scanTranscript(doc, f);
    errors.push(...r.errors);
    violations.push(...r.violations);
    clientFrames += r.clientFrames;
  }
  if (files.length > 0 && errors.length === 0 && clientFrames === 0) errors.push("no client frames in any transcript (no evidence)");
  return { errors, violations, files: files.length, clientFrames };
}

function main(argv) {
  const r = scanPaths(argv);
  for (const e of r.errors) console.error(`wire-scan: error: ${e}`);
  for (const v of r.violations) console.error(`wire-scan: violation: ${v}`);
  if (r.errors.length || r.violations.length) {
    console.error(`wire-scan: FAIL (${r.errors.length} errors, ${r.violations.length} violations)`);
    return 1;
  }
  console.log(`wire-scan: clean (${r.files} transcripts, ${r.clientFrames} client frames)`);
  console.log(`wire-scan: limitation: ${DCR_LIMITATION}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
