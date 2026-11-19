// Evidence for extension-wide rows in docs/conformance/extensions.md (EXT-REG-1, EXT-STREAM-1,
// EXT-PIN-1, EXT-STAGE-1, EXT-STAGE-2, EXT-PORT-1, EXT-apps-BRIDGE, EXT-EXP-*).
// Each static scanner has a self-check that it flags a planted bad case.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_EXTENSIONS } from "../src/gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PKGS = join(ROOT, "packages");
// Explicit list, not readdir: other tests create temporary packages/ext-* dirs concurrently.
const EXT_PKGS = [...ALL_EXTENSIONS].sort();

describe("extension package list", () => {
  it("every listed ext-* package directory exists", () => {
    for (const p of EXT_PKGS) expect(existsSync(join(PKGS, p, "package.json")), `${p} exists`).toBe(true);
  });
});

function srcFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (/\.(ts|mts|cts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const pkgSrc = (pkg: string) => srcFiles(join(PKGS, pkg, "src"));
const allImplSrc = () =>
  readdirSync(PKGS).filter((n) => n !== "conformance" && n !== "fixtures").flatMap(pkgSrc);

/** Files whose text matches any of the patterns. */
function scan(files: Array<{ path: string; text: string }>, patterns: RegExp[]): string[] {
  return files.filter((f) => patterns.some((p) => p.test(f.text))).map((f) => f.path);
}
const read = (paths: string[]) => paths.map((path) => ({ path, text: readFileSync(path, "utf8") }));

// ---------------------------------------------------------------- EXT-REG-1
const PROBE = `
const before = new Set(Reflect.ownKeys(globalThis).map(String));
const core = await import(process.argv[2]);
const protoBefore = Object.getOwnPropertyNames(core.ExtensionRegistry.prototype).join(",");
const reg = new core.ExtensionRegistry();
for (const u of process.argv.slice(3)) await import(u);
// undici (Node's fetch) lazily installs its own dispatcher symbol; that is the runtime, not an extension.
const added = Reflect.ownKeys(globalThis).map(String).filter((k) => !before.has(k) && !k.startsWith("Symbol(undici."));
const protoAfter = Object.getOwnPropertyNames(core.ExtensionRegistry.prototype).join(",");
console.log(JSON.stringify({ added, protoChanged: protoBefore !== protoAfter, regKeys: Object.values(reg).map((v) => v instanceof Map ? v.size : null) }));
`;
function probe(urls: string[]): { added: string[]; protoChanged: boolean; regKeys: Array<number | null> } {
  const dir = mkdtempSync(join(tmpdir(), "ext-reg-"));
  const file = join(dir, "probe.mjs");
  writeFileSync(file, PROBE);
  const core = pathToFileURL(join(PKGS, "core/dist/index.js")).href;
  return JSON.parse(execFileSync(process.execPath, [file, core, ...urls], { cwd: ROOT, encoding: "utf8" }));
}

describe("[EXT-REG-1] importing an extension package registers nothing", () => {
  it("[EXT-REG-1] self-check: probe detects a module that mutates global state on import", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-reg-bad-"));
    const bad = join(dir, "bad.mjs");
    writeFileSync(bad, "globalThis.__mcpExtAutoRegistered = true;\n");
    expect(probe([pathToFileURL(bad).href]).added).toContain("__mcpExtAutoRegistered");
  });

  it("[EXT-REG-1] every ext-* dist entry imports with no new globals and no core registry change", () => {
    expect(EXT_PKGS.length).toBeGreaterThanOrEqual(5);
    const urls = EXT_PKGS.map((p) => {
      const entry = join(PKGS, p, "dist/index.js");
      expect(existsSync(entry), `${p} built`).toBe(true);
      return pathToFileURL(entry).href;
    });
    const r = probe(urls);
    expect(r.added).toEqual([]);
    expect(r.protoChanged).toBe(false);
    for (const n of r.regKeys) if (n !== null) expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------- EXT-STREAM-1
/** Non-relative module specifiers that are not node builtins nor the core root entry. */
function nonCoreImports(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const s = m[1]!;
    // mrtr-cache is the public MRTR helper (input-required elicitation); it is not a transport or core internal.
    if (s.startsWith(".") || s.startsWith("node:") || s === "@mcp-client/core" || s === "@mcp-client/mrtr-cache") continue;
    out.push(s);
  }
  return out;
}

describe("[EXT-STREAM-1] Tasks and Events use only the core public API", () => {
  it("[EXT-STREAM-1] self-check: flags deep core and transport imports", () => {
    expect(nonCoreImports(`import { x } from "@mcp-client/core/src/request.js";`)).toHaveLength(1);
    expect(nonCoreImports(`import { y } from "@mcp-client/transport-http";`)).toHaveLength(1);
    expect(nonCoreImports(`import type { StreamHandle } from "@mcp-client/core";`)).toHaveLength(0);
  });

  it("[EXT-STREAM-1] ext-tasks and ext-events import only @mcp-client/core root and use ClientRequest/StreamHandle", () => {
    const core = readFileSync(join(PKGS, "core/src/request.ts"), "utf8");
    expect(core).toMatch(/export interface ClientRequest\b/);
    expect(core).toMatch(/export interface StreamHandle\b/);
    for (const pkg of ["ext-tasks", "ext-events"]) {
      const files = read(pkgSrc(pkg));
      expect(files.length).toBeGreaterThan(0);
      const bad = files.flatMap((f) => nonCoreImports(f.text).map((s) => `${f.path}: ${s}`));
      expect(bad).toEqual([]);
      const all = files.map((f) => f.text).join("\n");
      expect(all).toMatch(/from ["']@mcp-client\/core["']/);
      expect(all).toMatch(/\b(ClientRequest|StreamHandle)\b/);
    }
  });
});

// ---------------------------------------------------------------- EXT-PIN-1
const PIN_ROWS: Array<[string, string]> = [
  ["ext-tasks", "cc9aaac1047a9440b07486e38f37060bbebeef4c"],
  ["ext-skills", "649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a"],
  ["ext-apps", "ea3e9d0e624a20bc1c51310292f09d9b8ed17161"],
  ["ext-auth", "15ca394e00a66434520b9ade26294999295a43ae"],
  ["ext-server-card", "28db12c9b4a379489d46e49bf1bd4a991f05c9b7"],
];
function pinnedCommit(pins: string, kind: string): string | null {
  const row = pins.split("\n").find((l) => l.startsWith(`| ${kind} |`));
  return row?.match(/`([0-9a-f]{40})`/)?.[1] ?? null;
}

describe("[EXT-PIN-1] each implemented extension records repo and commit", () => {
  const pins = readFileSync(join(ROOT, "docs/conformance/PINS.md"), "utf8");
  it("[EXT-PIN-1] self-check: missing or short pin is not accepted", () => {
    expect(pinnedCommit("| ext-x | `abc123` | t |", "ext-x")).toBeNull();
    expect(pinnedCommit("| ext-y | x |", "ext-x")).toBeNull();
  });
  it("[EXT-PIN-1] PINS.md lists a 40-hex commit for every implemented extension repo, plus SEP-3415 for Events", () => {
    for (const [kind, sha] of PIN_ROWS) expect(pinnedCommit(pins, kind), kind).toBe(sha);
    const sep = pins.slice(pins.indexOf("## SEP-3415"));
    expect(sep).toMatch(/`[0-9a-f]{40}`/);
    // every ext-* package maps to one of the pinned sources
    const source: Record<string, string> = {
      "ext-tasks": "ext-tasks", "ext-skills": "ext-skills", "ext-apps": "ext-apps",
      "ext-client-credentials": "ext-auth", "ext-enterprise-auth": "ext-auth",
      "ext-server-cards": "ext-server-card", "ext-events": "SEP-3415", "ext-events-webhook": "SEP-3415",
    };
    for (const p of EXT_PKGS) expect(source[p], `${p} has a pinned source`).toBeDefined();
  });
});

// ---------------------------------------------------------------- EXT-STAGE-1
function deps(pkg: string): string[] {
  const j = JSON.parse(readFileSync(join(PKGS, pkg, "package.json"), "utf8"));
  return Object.keys({ ...j.dependencies, ...j.peerDependencies, ...j.optionalDependencies });
}

describe("[EXT-STAGE-1] extensions are opt-in packages outside the core claim", () => {
  it("[EXT-STAGE-1] core depends on and imports no ext-* package", () => {
    expect(deps("core").filter((d) => d.includes("/ext-"))).toEqual([]);
    const coreFiles = read(pkgSrc("core"));
    expect(coreFiles.length).toBeGreaterThan(0);
    expect(scan(coreFiles, [/["']@mcp-client\/ext-/])).toEqual([]);
    // self-check
    expect(scan([{ path: "x", text: `import "@mcp-client/ext-skills";` }], [/["']@mcp-client\/ext-/])).toEqual(["x"]);
  });
  it("[EXT-STAGE-1] every ext-* is its own package with its own entry", () => {
    for (const p of EXT_PKGS) {
      const j = JSON.parse(readFileSync(join(PKGS, p, "package.json"), "utf8"));
      expect(j.name).toBe(`@mcp-client/${p}`);
      expect(j.exports).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------- EXT-PORT-1
describe("[EXT-PORT-1] extension host ports live in the extension package, not core", () => {
  const EXT_PORT = /\binterface\s+\w*(Task|Skill|Event|Webhook|Card|App|Ui|Assertion|ClientSecret)\w*Port\b/;
  it("[EXT-PORT-1] self-check: detects a planted extension port", () => {
    expect(EXT_PORT.test("export interface SkillApprovalPort { x(): void }")).toBe(true);
    expect(EXT_PORT.test("export interface ConsentPort {}")).toBe(false);
  });
  it("[EXT-PORT-1] core declares no extension-specific port", () => {
    expect(scan(read(pkgSrc("core")), [EXT_PORT])).toEqual([]);
  });
});

// ---------------------------------------------------------------- excluded rows
const EXCLUDED: Array<[string, RegExp[]]> = [
  ["EXT-apps-BRIDGE", [/postMessage/, /\biframe\b/i, /["']ui\/(initialize|notifications|message|open-link)/, /sandbox[- ]?proxy/i]],
  ["EXT-EXP-INTERCEPT", [/interceptor/i, /ext-interceptors/]],
  ["EXT-EXP-TOOLANN", [/ext-tool-annotations/, /io\.modelcontextprotocol\/tool-annotations/]],
  ["EXT-EXP-TRIGGERS", [/trigger/i, /triggers-events/]],
  ["EXT-EXP-FUTURE", [/specification\/experimental/, /experimental-ext-/]],
];

describe("excluded experimental extensions have no implementation or auto-adoption", () => {
  for (const [id, pats] of EXCLUDED) {
    it(`[${id}] self-check: scanner catches a planted reference`, () => {
      const plant = { "EXT-apps-BRIDGE": "window.parent.postMessage({})", "EXT-EXP-INTERCEPT": "class RequestInterceptor {}",
        "EXT-EXP-TOOLANN": `const id = "io.modelcontextprotocol/tool-annotations";`, "EXT-EXP-TRIGGERS": "onTrigger()",
        "EXT-EXP-FUTURE": `fetch("specification/experimental/x.md")` }[id]!;
      expect(scan([{ path: "planted.ts", text: plant }], pats)).toEqual(["planted.ts"]);
    });
    it(`[${id}] no package source references it`, () => {
      const files = read(id === "EXT-apps-BRIDGE" ? pkgSrc("ext-apps").concat(pkgSrc("core")) : allImplSrc());
      expect(files.length).toBeGreaterThan(0);
      expect(scan(files, pats)).toEqual([]);
    });
  }
  it("[EXT-STAGE-2] experimental items are neither registered nor advertised: no ext package names an experimental id", () => {
    const pats = EXCLUDED.filter(([id]) => id.startsWith("EXT-EXP")).flatMap(([, p]) => p);
    expect(scan(read(allImplSrc()), pats)).toEqual([]);
    const extIds = new Set<string>();
    for (const f of read(EXT_PKGS.flatMap(pkgSrc)))
      for (const m of f.text.matchAll(/["']io\.modelcontextprotocol\/([a-z-]+)["']/g)) extIds.add(m[1]!);
    const allowed = new Set(["tasks", "skills", "apps", "events", "events-webhook", "server-card", "server-cards", "oauth-client-credentials",
      "enterprise-managed-authorization", "subscriptionId", "clientCapabilities", "clientInfo", "logLevel", "protocolVersion", "ui"]);
    expect([...extIds].filter((x) => !allowed.has(x))).toEqual([]);
  });
});
