#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const BUILTIN_SET = new Set(builtinModules.map((m) => (m.startsWith("node:") ? m.slice(5) : m)));

// 1. Run dependency-cruiser across packages/ (skip on Node prereleases like -alpha where semver refuses >=26)
if (!process.version.includes("-")) {
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "--config", join(ROOT, ".dependency-cruiser.cjs"), PACKAGES_DIR],
    { cwd: ROOT, stdio: "inherit" }
  );
}

// 2. Mandatory static TypeScript import/export/cycle analyzer (works across all TS versions including tsgo/7.x)
function walkTs(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const workspaceDirs = new Map(); // shortName -> dirName
const packageDirs = [];
for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgFile = join(PACKAGES_DIR, entry.name, "package.json");
  if (!existsSync(pkgFile)) continue;
  packageDirs.push(entry.name);
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  if (typeof pkg.name === "string" && pkg.name.startsWith("@mcp/")) {
    workspaceDirs.set(pkg.name.slice("@mcp/".length), entry.name);
  }
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "default",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "await",
  "yield",
  "new",
  "else",
  "do",
]);

function canStartRegex(tokens) {
  const prev = tokens[tokens.length - 1];
  if (!prev) return true;
  if (prev.type === "punct") {
    return prev.value !== ")" && prev.value !== "]" && prev.value !== "++" && prev.value !== "--";
  }
  if (prev.type === "ident") {
    return REGEX_PRECEDING_KEYWORDS.has(prev.value);
  }
  return false;
}

function tokenizeTs(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  let sawNewline = false;

  function emit(tok, nl = sawNewline) {
    tokens.push({ ...tok, precededByNewline: nl });
    sawNewline = false;
  }

  function scanTemplate() {
    const startNewline = sawNewline;
    sawNewline = false;
    i++; // skip `
    let val = "";
    let hasExpr = false;
    while (i < n) {
      const ch = src[i];
      if (ch === "\\") {
        if (!hasExpr) val += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === "`") {
        i++;
        emit({ type: "template", value: hasExpr ? undefined : val, hasExpr }, startNewline);
        return;
      }
      if (ch === "$" && src[i + 1] === "{") {
        hasExpr = true;
        i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          if (src[i] === "{") { depth++; emit({ type: "punct", value: "{" }); i++; continue; }
          if (src[i] === "}") {
            depth--;
            emit({ type: "punct", value: "}" });
            i++;
            if (depth === 0) break;
            continue;
          }
          scanOne();
        }
        continue;
      }
      if (!hasExpr) val += ch;
      i++;
    }
  }

  function scanOne() {
    if (i >= n) return;
    const ch = src[i];
    if (/\s/.test(ch)) {
      if (ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029") sawNewline = true;
      i++;
      return;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      return;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n" || src[i] === "\r" || src[i] === "\u2028" || src[i] === "\u2029") {
          sawNewline = true;
        }
        i++;
      }
      i += 2;
      return;
    }
    if (ch === "/" && canStartRegex(tokens)) {
      const nl = sawNewline;
      i++; // skip opening /
      let inClass = false;
      let closed = false;
      while (i < n) {
        const c = src[i];
        if (c === "\\") { i += 2; continue; }
        if (c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029") break;
        if (c === "[" && !inClass) { inClass = true; i++; continue; }
        if (c === "]" && inClass) { inClass = false; i++; continue; }
        if (c === "/" && !inClass) { i++; closed = true; break; }
        i++;
      }
      if (closed) {
        while (i < n && /[A-Za-z]/.test(src[i])) i++;
      }
      emit({ type: "regex" }, nl);
      return;
    }
    if (ch === "'" || ch === '"') {
      const nl = sawNewline;
      const q = ch;
      i++;
      let val = "";
      while (i < n && src[i] !== q) {
        if (src[i] === "\\") { val += src[i + 1] ?? ""; i += 2; continue; }
        val += src[i++];
      }
      i++; // skip closing quote
      emit({ type: "string", value: val }, nl);
      return;
    }
    if (ch === "`") { scanTemplate(); return; }
    if (/[0-9]/.test(ch)) {
      const nl = sawNewline;
      let num = ch;
      i++;
      while (i < n && /[0-9A-Za-z_]/.test(src[i])) num += src[i++];
      if (src[i] === "." && src[i + 1] !== ".") {
        num += ".";
        i++;
        while (i < n && /[0-9A-Za-z_]/.test(src[i])) num += src[i++];
      }
      emit({ type: "number", value: num }, nl);
      return;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const nl = sawNewline;
      let id = ch;
      i++;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i])) id += src[i++];
      emit({ type: "ident", value: id }, nl);
      return;
    }
    if ((ch === "+" && src[i + 1] === "+") || (ch === "-" && src[i + 1] === "-") || (ch === "=" && src[i + 1] === ">")) {
      emit({ type: "punct", value: ch + src[i + 1] });
      i += 2;
      return;
    }
    emit({ type: "punct", value: ch });
    i++;
  }

  while (i < n) scanOne();
  return tokens;
}

function areNamedImportsAllTypeOnly(clauseTokens) {
  // Expected: '{', ..., '}' (no default or namespace import before/after '{')
  if (clauseTokens.length < 2 || clauseTokens[0].value !== "{" || clauseTokens[clauseTokens.length - 1].value !== "}") {
    return false;
  }
  const inner = clauseTokens.slice(1, -1);
  if (inner.length === 0) return false;
  // Split by ',' and check each non-empty specifier starts with ident 'type' followed by ident (not 'as' or ',')
  let start = 0;
  let count = 0;
  for (let idx = 0; idx <= inner.length; idx++) {
    if (idx === inner.length || (inner[idx].type === "punct" && inner[idx].value === ",")) {
      const part = inner.slice(start, idx);
      start = idx + 1;
      if (part.length === 0) continue;
      count++;
      if (part[0].type !== "ident" || part[0].value !== "type") return false;
      // Handle edge case `import { type as x }` where `type` is the imported symbol name
      if (part.length >= 2 && part[1].type === "ident" && part[1].value === "as" && (part.length === 3 || part[2]?.value !== "as")) {
        return false;
      }
    }
  }
  return count > 0;
}

function extractDeps(filePath) {
  const src = readFileSync(filePath, "utf8");
  const tokens = tokenizeTs(src);
  const deps = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const prev = i > 0 ? tokens[i - 1] : undefined;
    const isMemberProp = prev?.type === "punct" && prev.value === ".";

    // Dynamic import("spec") / import(`spec`) / import("spec", { with: ... })
    if (!isMemberProp && t.type === "ident" && t.value === "import" && tokens[i + 1]?.value === "(") {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      if (
        arg &&
        (arg.type === "string" || (arg.type === "template" && !arg.hasExpr)) &&
        after?.type === "punct" &&
        (after.value === ")" || after.value === ",")
      ) {
        deps.push({ spec: arg.value, typeOnly: false });
      }
      continue;
    }

    // require("spec") / require(`spec`)
    if (!isMemberProp && t.type === "ident" && t.value === "require" && tokens[i + 1]?.value === "(") {
      const arg = tokens[i + 2];
      const after = tokens[i + 3];
      if (
        arg &&
        (arg.type === "string" || (arg.type === "template" && !arg.hasExpr)) &&
        after?.type === "punct" &&
        (after.value === ")" || after.value === ",")
      ) {
        deps.push({ spec: arg.value, typeOnly: false });
      }
      continue;
    }

    // Statement-level import / export
    const atStmtStart =
      !prev ||
      t.precededByNewline ||
      (prev.type === "punct" && (prev.value === ";" || prev.value === "{" || prev.value === "}"));
    if (!atStmtStart || isMemberProp || t.type !== "ident") continue;

    if (t.value === "import") {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.type === "string") {
        deps.push({ spec: next.value, typeOnly: false });
        continue;
      }
      if (next.type !== "ident" && next.value !== "*" && next.value !== "{") continue;
      let j = i + 1;
      let typePrefix = false;
      if (tokens[j]?.type === "ident" && tokens[j].value === "type") {
        // Distinguish `import type Foo from ...` / `import type { ... } from ...` from `import type from ...`
        const afterType = tokens[j + 1];
        if (afterType && !(afterType.type === "ident" && afterType.value === "from")) {
          typePrefix = true;
          j++;
        }
      }
      const clauseStart = j;
      while (j < tokens.length && !(tokens[j].type === "ident" && tokens[j].value === "from") && tokens[j].value !== ";") {
        j++;
      }
      if (tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
        const clauseTokens = tokens.slice(clauseStart, j);
        const typeOnly = typePrefix || areNamedImportsAllTypeOnly(clauseTokens);
        deps.push({ spec: tokens[j + 1].value, typeOnly });
        i = j + 1;
      }
      continue;
    }

    if (t.value === "export") {
      let j = i + 1;
      let typePrefix = false;
      if (tokens[j]?.type === "ident" && tokens[j].value === "type") {
        typePrefix = true;
        j++;
      }
      const first = tokens[j];
      if (!first || (first.value !== "*" && first.value !== "{")) continue;
      const clauseStart = j;
      while (j < tokens.length && !(tokens[j].type === "ident" && tokens[j].value === "from") && tokens[j].value !== ";") {
        j++;
      }
      if (tokens[j]?.type === "ident" && tokens[j].value === "from" && tokens[j + 1]?.type === "string") {
        const clauseTokens = tokens.slice(clauseStart, j);
        const typeOnly = typePrefix || areNamedImportsAllTypeOnly(clauseTokens);
        deps.push({ spec: tokens[j + 1].value, typeOnly });
        i = j + 1;
      }
    }
  }
  return deps;
}

function resolveRelativeTs(fromFile, spec) {
  const raw = resolve(dirname(fromFile), spec);
  const candidates = [];
  if (raw.endsWith(".js") || raw.endsWith(".mjs") || raw.endsWith(".cjs")) {
    const stem = raw.slice(0, raw.lastIndexOf("."));
    candidates.push(`${stem}.ts`, `${stem}.mts`);
  } else if (raw.endsWith(".ts") || raw.endsWith(".mts")) {
    candidates.push(raw);
  } else {
    candidates.push(`${raw}.ts`, `${raw}.mts`, join(raw, "index.ts"), join(raw, "index.mts"));
  }
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return candidates[0];
}

function classifyEdge(fromFile, dep) {
  const { spec, typeOnly } = dep;
  if (spec.startsWith("node:") || BUILTIN_SET.has(spec)) {
    return { kind: "builtin", spec, typeOnly, targetRel: null };
  }
  if (spec.startsWith(".")) {
    const resolved = resolveRelativeTs(fromFile, spec);
    const targetRel = relative(ROOT, resolved).split("\\").join("/");
    return { kind: "repo", spec, typeOnly, targetRel, resolved };
  }
  if (spec.startsWith("@mcp/")) {
    const rest = spec.slice("@mcp/".length);
    const slash = rest.indexOf("/");
    const short = slash === -1 ? rest : rest.slice(0, slash);
    const subpath = slash === -1 ? "" : rest.slice(slash + 1);
    const dirName = workspaceDirs.get(short);
    if (dirName) {
      const targetRel = subpath
        ? `packages/${dirName}/${subpath}`
        : `packages/${dirName}/src/index.ts`;
      const resolved = join(ROOT, targetRel);
      return { kind: "workspace", spec, typeOnly, targetRel, resolved, isDeepSubpath: subpath !== "" };
    }
  }
  return { kind: "external", spec, typeOnly, targetRel: null };
}

const errors = [];
const srcGraph = new Map(); // relPath -> Set<relPath>

for (const pkgDir of packageDirs.sort()) {
  const srcFiles = walkTs(join(PACKAGES_DIR, pkgDir, "src"));
  const testFiles = walkTs(join(PACKAGES_DIR, pkgDir, "test"));

  for (const file of [...srcFiles, ...testFiles]) {
    const fromRel = relative(ROOT, file).split("\\").join("/");
    const inSrc = fromRel.startsWith(`packages/${pkgDir}/src/`);
    const deps = extractDeps(file);
    if (inSrc && !srcGraph.has(fromRel)) srcGraph.set(fromRel, new Set());

    for (const dep of deps) {
      const edge = classifyEdge(file, dep);
      const { spec, typeOnly, targetRel } = edge;

      if (inSrc && !typeOnly && targetRel && (edge.kind === "repo" || edge.kind === "workspace") && existsSync(edge.resolved)) {
        srcGraph.get(fromRel).add(targetRel);
      }

      // Global rules (all packages/*/{src,test}/**/*.ts)
      if (targetRel?.startsWith("adapters/") || /^adapters\//.test(spec)) {
        errors.push(`[packages-never-import-adapters] ${fromRel} -> ${spec}`);
      }
      if (/(@earendil-works\/pi-|@mariozechner\/pi-|@jangmanj\/pi-mcp-ext|@modelcontextprotocol\/sdk|pi-mcp-ext)/.test(spec)) {
        errors.push(`[packages-never-import-pi-or-sdk] ${fromRel} -> ${spec}`);
      }
      if (targetRel) {
        const m = /^packages\/([^/]+)\/src\//.exec(targetRel);
        if (m && m[1] !== pkgDir && (edge.kind === "repo" || edge.isDeepSubpath)) {
          errors.push(`[no-deep-cross-package-imports] ${fromRel} -> ${spec} (${targetRel})`);
        }
      }

      // Architectural rules scoped to packages/*/src/**/*.ts (matching tsconfig.json scope)
      if (!inSrc) continue;

      if (pkgDir === "core") {
        if (edge.kind === "builtin") {
          errors.push(`[core-no-node-builtins] ${fromRel} -> ${spec}`);
        }
        const outsideCore =
          edge.kind === "builtin" ||
          edge.kind === "external" ||
          (targetRel !== null && !targetRel.startsWith("packages/core/"));
        if (outsideCore && !typeOnly) {
          errors.push(`[core-self-contained-no-node] ${fromRel} -> ${spec}`);
        }
      }

      if ((pkgDir === "ops" || pkgDir === "auth" || pkgDir === "mrtr-cache") && targetRel?.startsWith("packages/transport-")) {
        errors.push(`[ops-auth-mrtr-never-import-transports] ${fromRel} -> ${spec}`);
      }
      if (pkgDir === "transport-http" && targetRel?.startsWith("packages/auth/")) {
        errors.push(`[transport-http-never-imports-auth] ${fromRel} -> ${spec}`);
      }
      if (/^(core|ops|transport-.*|auth|mrtr-cache)$/.test(pkgDir) && targetRel?.startsWith("packages/ext-")) {
        errors.push(`[core-ops-transports-never-import-extensions] ${fromRel} -> ${spec}`);
      }
      if (/^(core|ops|transport-.*|auth|mrtr-cache|ext-.*)$/.test(pkgDir) && targetRel?.startsWith("packages/telemetry-otel/")) {
        errors.push(`[core-ops-transports-never-import-telemetry-otel] ${fromRel} -> ${spec}`);
      }
      if (pkgDir.startsWith("ext-") && targetRel?.startsWith("packages/transport-")) {
        errors.push(`[ext-src-never-imports-transports] ${fromRel} -> ${spec}`);
      }
    }
  }
}

// Rule: no-circular across packages/*/src/**/*.ts
const visitState = new Map(); // 0/undefined = unvisited, 1 = visiting, 2 = done
const stack = [];
function dfs(node) {
  visitState.set(node, 1);
  stack.push(node);
  for (const next of srcGraph.get(node) ?? []) {
    const st = visitState.get(next);
    if (st === 1) {
      const idx = stack.indexOf(next);
      errors.push(`[no-circular] ${[...stack.slice(idx), next].join(" -> ")}`);
    } else if (!st) {
      dfs(next);
    }
  }
  stack.pop();
  visitState.set(node, 2);
}
for (const node of [...srcGraph.keys()].sort()) {
  if (!visitState.get(node)) dfs(node);
}

if (errors.length > 0) {
  for (const e of errors) console.error(`check-deps: ${e}`);
  process.exit(1);
}

// 3. Enforce zero Node-only globals/imports inside packages/core/src
const CORE_SRC = join(ROOT, "packages/core/src");
const BANNED_CORE = [
  /from\s+["']node:/,
  /require\(\s*["']node:/,
  /\bprocess\s*\./,
  /\bBuffer\s*\./,
  /\bBuffer\b/,
];

for (const file of walkTs(CORE_SRC)) {
  if (file.endsWith("schema/types.ts")) continue;
  const text = readFileSync(file, "utf8");
  for (const pat of BANNED_CORE) {
    if (pat.test(text)) {
      console.error(`check-deps: forbidden Node reference (${pat}) in ${file}`);
      process.exit(1);
    }
  }
}

console.log(`check-deps: ok (${srcGraph.size} src modules checked)`);
