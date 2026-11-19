import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts/assert-no-pi.mjs");

// Real denied names come from the checked-in deny list so this source never spells them.
const denyList = JSON.parse(readFileSync(join(repoRoot, "packages/conformance/deny-pi.json"), "utf8")) as {
  packages: string[];
};
const deniedPkg = (suffix: string): string => {
  const hit = denyList.packages.find((p) => p.endsWith(suffix));
  if (!hit) throw new Error(`deny-pi.json has no package ending in ${suffix}`);
  return hit;
};
const PI_AI = deniedPkg("/pi-ai");
const PI_TUI = deniedPkg("/pi-tui");
const PI_ROUTER = deniedPkg("/pi-router");
const MCP_SDK = deniedPkg("/sdk");
const re = (s: string) => new RegExp(s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "anp-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Gate-shaped environment: clean HOME, no PI_*, no XDG_*, no NODE_PATH.
const cleanEnv = (home: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("PI_") || k.startsWith("XDG_") || k === "NODE_PATH" || k === "NODE_OPTIONS") continue;
    if (k.startsWith("VITEST") || k.startsWith("ASSERT_NO_PI")) continue;
    env[k] = v;
  }
  env.HOME = home;
  return env;
};

const run = (args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
  const home = tmp();
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(home),
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const writePkg = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(dir, "index.js"), "module.exports = { loaded: true };\n");
};

/** A clean project root: lockfile and node_modules with only allowed packages. */
const cleanRoot = () => {
  const root = tmp();
  writeFileSync(
    join(root, "package-lock.json"),
    JSON.stringify({
      name: "x",
      lockfileVersion: 3,
      packages: { "": { name: "x", dependencies: { "left-pad": "1.0.0" } }, "node_modules/left-pad": { version: "1.0.0" } },
    }),
  );
  writePkg(join(root, "node_modules/left-pad"), "left-pad");
  return root;
};

describe("static scans", () => {
  it("passes on a clean root", () => {
    const r = run(["--root", cleanRoot()]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("assert-no-pi: ok");
  });

  it("fails when package-lock.json lists a denied package", () => {
    const root = cleanRoot();
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, [`node_modules/foo/node_modules/${PI_AI}`]: { version: "1.0.0" } },
      }),
    );
    const r = run(["--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`package-lock\\.json: .*${re(PI_AI).source}`));
  });

  it("fails when node_modules contains a denied package (nested, scoped)", () => {
    const root = cleanRoot();
    writePkg(join(root, "node_modules/left-pad/node_modules", MCP_SDK), MCP_SDK);
    const r = run(["--root", root]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`node_modules: .*${re(MCP_SDK).source}`));
  });

  it("fails when a PI_* variable is set", () => {
    const env = { ...cleanEnv(tmp()), PI_SESSION: "1" };
    const r = run(["--root", cleanRoot()], { env });
    expect(r.code).toBe(1);
    expect(r.err).toContain("PI_SESSION");
  });

  it("fails when NODE_PATH is set or XDG_* non-empty", () => {
    const r1 = run(["--root", cleanRoot()], { env: { ...cleanEnv(tmp()), NODE_PATH: "/x" } });
    expect(r1.code).toBe(1);
    expect(r1.err).toContain("NODE_PATH");
    const r2 = run(["--root", cleanRoot()], { env: { ...cleanEnv(tmp()), XDG_CONFIG_HOME: "/x" } });
    expect(r2.code).toBe(1);
    expect(r2.err).toContain("XDG_CONFIG_HOME");
  });
});

describe("protected node wrapper", () => {
  it("runs node args and propagates exit status", () => {
    const root = cleanRoot();
    const ok = run(["--root", root, "--", "-e", "console.log(require('left-pad').loaded)"], { cwd: root });
    expect(ok.err).toBe("");
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("true");
    const bad = run(["--root", root, "--", "-e", "process.exit(7)"], { cwd: root });
    expect(bad.code).toBe(7);
  });

  it("fails the process when a denied ESM import is caught", () => {
    const root = cleanRoot();
    writePkg(join(root, "node_modules", PI_AI), PI_AI);
    const entry = join(root, "entry.mjs");
    writeFileSync(
      entry,
      `try { await import(${JSON.stringify(PI_AI)}); console.log('imported'); } catch (e) { console.log('caught:' + e.code); }\nprocess.exit(0);\n`,
    );
    // Static scan would catch this package; use a separate clean root for scans.
    const r = run(["--root", cleanRoot(), "--", entry], { cwd: root });
    expect(r.out).toContain("caught:");
    expect(r.out).not.toContain("imported");
    expect(r.err).toMatch(new RegExp(`denied resolution in gate process: ${re(PI_AI).source}`));
    expect(r.code).toBe(1);
  });

  it("fails the process when a denied require() is caught, even for a missing package", () => {
    const root = cleanRoot();
    const entry = join(root, "entry.cjs");
    writeFileSync(entry, `try { require(${JSON.stringify(PI_ROUTER + "/sub")}); } catch {}\nconsole.log('done');\n`);
    const r = run(["--root", root, "--", entry], { cwd: root });
    expect(r.out).toContain("done");
    expect(r.err).toMatch(new RegExp(`denied resolution in gate process: ${re(PI_ROUTER + "/sub").source}`));
    expect(r.code).toBe(1);
  });

  it("fails the process when a denied import happens in a child node process", () => {
    const root = cleanRoot();
    const entry = join(root, "parent.mjs");
    writeFileSync(
      entry,
      `import { spawnSync } from "node:child_process";
spawnSync(process.execPath, ["-e", ${JSON.stringify(`import(${JSON.stringify(PI_TUI)}).catch(() => {})`)}], { stdio: "inherit" });
`,
    );
    const r = run(["--root", root, "--", entry], { cwd: root });
    expect(r.err).toMatch(re(PI_TUI));
    expect(r.code).toBe(1);
  });

  it("fails the process when adapter code is loaded", () => {
    const root = cleanRoot();
    mkdirSync(join(root, "adapters/pi"), { recursive: true });
    writeFileSync(join(root, "adapters/pi/index.mjs"), "export const x = 1;\n");
    const entry = join(root, "entry.mjs");
    writeFileSync(entry, "try { await import('./adapters/pi/index.mjs'); } catch {}\n");
    const r = run(["--root", root, "--", entry], { cwd: root });
    expect(r.err).toMatch(/adapter code/);
    expect(r.code).toBe(1);
  });
});
