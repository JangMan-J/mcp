import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import piMcpExtension from "./index.js";
import type { PiExtensionAPI } from "./pi-extension.js";
import { BRANCH_CUSTOM_TYPE } from "./branch.js";

// Fake Pi in a scratch env: PI_CODING_AGENT_DIR and the project cwd live in a temp dir, never ~/.pi/agent.
const dirs: string[] = [];
const prevDir = process.env["PI_CODING_AGENT_DIR"];
afterEach(async () => {
  if (prevDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = prevDir;
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

async function scratch() {
  const root = await mkdtemp(join(tmpdir(), "pi-index-"));
  dirs.push(root);
  const agent = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agent, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  // Servers are disabled so no process is spawned; listing still shows which config layers loaded.
  await writeFile(join(agent, "mcp.json"), JSON.stringify({ mcpServers: { globalsrv: { command: "fake", enabled: false } } }));
  await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { projsrv: { command: "fake", enabled: false } } }));
  process.env["PI_CODING_AGENT_DIR"] = agent;
  return { cwd };
}

function fakePi() {
  const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
  const appended: { customType: string; data: unknown }[] = [];
  let mcp: { handler(args: string, ctx: any): Promise<void> } | undefined;
  const api: PiExtensionAPI = {
    registerCommand(name, cmd) { if (name === "mcp") mcp = cmd; },
    registerTool() {},
    on(ev, h) { handlers.set(ev, [...(handlers.get(ev) ?? []), h]); return () => {}; },
    appendEntry(customType, data) { appended.push({ customType, data }); },
  };
  const start = async (ctx: object) => { for (const h of handlers.get("session_start") ?? []) await h({}, ctx); };
  const list = async (ctx: object) => {
    const notes: string[] = [];
    await mcp!.handler("list", { ...ctx, ui: { notify: (m: string) => notes.push(m) } });
    return notes.join("\n");
  };
  return { api, appended, start, list };
}

const ui = { notify: () => {}, confirm: async () => false, select: async () => undefined };

describe("default piMcpExtension entrypoint", () => {
  it.each([
    ["trusted", { isProjectTrusted: () => true }, true],
    ["untrusted", { isProjectTrusted: () => false }, false],
    ["missing isProjectTrusted (fail closed)", {}, false],
    ["legacy projectTrusted flag only (ignored)", { projectTrusted: true }, false],
    ["throwing isProjectTrusted (fail closed)", { isProjectTrusted: () => { throw new Error("boom"); } }, false],
  ])("loads project config only when ctx.isProjectTrusted() is true: %s", async (_label, trust, loaded) => {
    const { cwd } = await scratch();
    const pi = fakePi();
    piMcpExtension(pi.api);
    const ctx = { cwd, ui, ...trust };
    await pi.start(ctx);
    const out = await pi.list(ctx);
    expect(out).toContain("globalsrv");
    if (loaded) expect(out).toContain("projsrv"); else expect(out).not.toContain("projsrv");
  });

  it("restores branch state from ctx.sessionManager.getBranch()", async () => {
    const { cwd } = await scratch();
    const pi = fakePi();
    piMcpExtension(pi.api);
    const getBranch = vi.fn(() => [{ type: "custom", customType: BRANCH_CUSTOM_TYPE, data: { cursor: "c1" } }]);
    await pi.start({ cwd, ui, isProjectTrusted: () => false, sessionManager: { getBranch } });
    expect(getBranch).toHaveBeenCalled();
  });
});
