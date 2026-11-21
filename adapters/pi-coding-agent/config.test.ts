import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { getToolExposure, isServerOverride, loadLayeredMcpConfig, mcpServerNamespace, readLegacyConfig, resolveServerVariables } from "./config.ts";

const stdio = { mcpServers: { fs: { command: "srv", args: ["-x"], env: { A: "1" }, cwd: "/tmp" } } };
const http = { mcpServers: { web: { url: "https://example.test/mcp", headers: { H: "v" }, type: "streamable-http" } } };

describe("readLegacyConfig", () => {
  it("returns [] for untrusted project before inspecting input [PICA-3]", () => {
    const trap = new Proxy({}, { get: () => { throw new Error("inspected"); } });
    expect(readLegacyConfig(trap, { source: "project" })).toEqual([]);
    expect(readLegacyConfig(trap, { source: "project", trusted: false })).toEqual([]);
    expect(readLegacyConfig(stdio, { source: "project" })).toEqual([]);
  });
  it("trusted project parses but is marked trusted/source [PICA-3]", () => {
    const [s] = readLegacyConfig(stdio, { source: "project", trusted: true });
    expect(s).toMatchObject({ name: "fs", source: "project", trusted: true, transport: "stdio", enabled: true });
  });
  it("validates and copies stdio fields, defaults enabled/exposure", () => {
    const [s] = readLegacyConfig(stdio);
    expect(s).toMatchObject({ transport: "stdio", command: "srv", args: ["-x"], env: { A: "1" }, cwd: "/tmp", exposure: "direct" });
    expect(s?.env).not.toBe(stdio.mcpServers.fs.env);
  });
  it("validates HTTP, streamable-http alias, and copies headers", () => {
    expect(readLegacyConfig(http)[0]).toMatchObject({ transport: "http", url: "https://example.test/mcp", headers: { H: "v" } });
    expect(() => readLegacyConfig({ mcpServers: { x: { url: "ftp://x" } } })).toThrow(/http/);
    expect(() => readLegacyConfig({ mcpServers: { x: { url: "https://x", type: "sse" } } })).toThrow(/SSE/);
  });
  it("copies aliases, toolExposure alias, enabled=false, description/timeout/oauth", () => {
    const raw = { mcpServers: { a: { command: "c", enabled: false, exposure: "codemode-deferred", aliases: ["a1"], toolExposure: { t: "hidden" }, description: "d", timeout: 5, oauth: { clientId: "id" } } } };
    expect(readLegacyConfig(raw)[0]).toMatchObject({ enabled: false, exposure: "codemode", aliases: ["a1"], toolExposure: { t: "hidden" }, description: "d", timeout: 5, oauth: { clientId: "id" } });
  });
  it("rejects invalid name, missing command/url, bad args/enabled/type", () => {
    expect(() => readLegacyConfig({ mcpServers: { "bad name": { command: "c" } } })).toThrow(/name/);
    expect(() => readLegacyConfig({ mcpServers: { a: {} } })).toThrow(/command/);
    expect(() => readLegacyConfig({ mcpServers: { a: { command: "c", args: [1] } } })).toThrow(/args/);
    expect(() => readLegacyConfig({ mcpServers: { a: { command: "c", enabled: "yes" } } })).toThrow(/enabled/);
    expect(() => readLegacyConfig({ mcpServers: { a: { command: "c", type: "ws" } } })).toThrow(/type/);
    expect(() => readLegacyConfig(null)).toThrow(/mcpServers/);
  });
  it("read-only — input unchanged, so rollback is removing the adapter entry [PICA-11]", () => {
    const raw = structuredClone(stdio);
    readLegacyConfig(raw, { source: "project", trusted: true });
    expect(raw).toEqual(stdio);
  });
});

const one = (srv: Record<string, unknown>, opts: Parameters<typeof readLegacyConfig>[1] = {}) => readLegacyConfig({ mcpServers: { s: srv } }, opts)[0];
const H = "https://example.test/mcp";

describe("oauth validation", () => {
  it("accepts a full valid oauth block and keeps unknown keys", () => {
    const oauth = { clientId: "id", clientSecret: "sec", callbackPort: 8123, callbackUrl: "http://localhost:8123/cb", scope: "a b", clientName: "pi", clientRegistration: "dcr", authServerMetadataUrl: "https://as.test/.well-known", extra: 1 };
    expect(one({ url: H, oauth })?.oauth).toEqual(oauth);
    expect(one({ url: H, oauth: { callbackUrl: "http://127.0.0.1/cb", callbackPort: 9 } })?.oauth).toMatchObject({ callbackPort: 9 });
    expect(one({ url: H, oauth: { callbackUrl: "http://[::1]:5/cb" } })?.oauth).toBeDefined();
    expect(one({ url: H, oauth: { authServerMetadataUrl: "http://localhost:1/m" } })?.oauth).toBeDefined();
  });
  it("rejects wrong field types", () => {
    for (const k of ["clientId", "clientSecret", "callbackUrl", "scope", "clientName", "authServerMetadataUrl"])
      expect(() => one({ url: H, oauth: { [k]: 5 } })).toThrow(new RegExp(k));
  });
  it("rejects bad callbackPort", () => {
    for (const p of [0, 65536, 1.5, "80", -1]) expect(() => one({ url: H, oauth: { callbackPort: p } })).toThrow(/callbackPort/);
    expect(one({ url: H, oauth: { callbackPort: 65535 } })).toBeDefined();
  });
  it("rejects bad callbackUrl", () => {
    for (const u of ["https://localhost/cb", "http://example.com/cb", "http://localhost/cb?x=1", "http://localhost/cb#f", "nope"])
      expect(() => one({ url: H, oauth: { callbackUrl: u } })).toThrow(/callbackUrl/);
    expect(() => one({ url: H, oauth: { callbackUrl: "http://localhost:1/cb", callbackPort: 2 } })).toThrow(/match/);
  });
  it("rejects blank clientName and unknown clientRegistration", () => {
    expect(() => one({ url: H, oauth: { clientName: "  " } })).toThrow(/clientName/);
    expect(() => one({ url: H, oauth: { clientRegistration: "manual" } })).toThrow(/clientRegistration/);
    for (const r of ["auto", "dcr", "cimd"]) expect(one({ url: H, oauth: { clientRegistration: r } })).toBeDefined();
  });
  it("cimd constraints", () => {
    expect(() => one({ url: H, oauth: { clientRegistration: "cimd", clientId: "x" } })).toThrow(/cimd/);
    expect(() => one({ url: H, oauth: { clientRegistration: "cimd", clientName: "x" } })).toThrow(/cimd/);
    expect(() => one({ url: H, oauth: { clientRegistration: "cimd", callbackUrl: "http://[::1]/callback" } })).toThrow(/cimd/);
    expect(() => one({ url: H, oauth: { clientRegistration: "cimd", callbackUrl: "http://localhost/cb" } })).toThrow(/cimd/);
    expect(one({ url: H, oauth: { clientRegistration: "cimd", callbackUrl: "http://127.0.0.1:7/callback" } })).toBeDefined();
  });
  it("rejects bad authServerMetadataUrl", () => {
    for (const u of ["http://as.test/m", "ftp://as.test", "bad"]) expect(() => one({ url: H, oauth: { authServerMetadataUrl: u } })).toThrow(/authServerMetadataUrl/);
  });
  it("still allows oauth on stdio servers but validates it", () => {
    expect(one({ command: "c", oauth: { clientId: "id" } })?.oauth).toEqual({ clientId: "id" });
    expect(() => one({ command: "c", oauth: { callbackPort: 0 } })).toThrow(/callbackPort/);
  });
});

describe("auth", () => {
  it("accepts auth on https and loopback http servers", () => {
    expect(one({ url: H, auth: { provider: "corp" } })?.auth).toEqual({ provider: "corp" });
    expect(one({ url: "http://localhost:3/mcp", auth: { provider: "p" } })?.auth).toEqual({ provider: "p" });
    expect(one({ url: "http://[::1]:3/mcp", auth: { provider: "p" } })?.auth).toEqual({ provider: "p" });
    expect(one({ url: H })).not.toHaveProperty("auth");
  });
  it("rejects auth on stdio, bad provider, insecure url, and project source", () => {
    expect(() => one({ command: "c", auth: { provider: "p" } })).toThrow(/HTTP/);
    expect(() => one({ url: H, auth: { provider: "" } })).toThrow(/provider/);
    expect(() => one({ url: H, auth: "p" })).toThrow(/provider/);
    expect(() => one({ url: "http://example.com/mcp", auth: { provider: "p" } })).toThrow(/https/);
    expect(() => one({ url: H, auth: { provider: "p" } }, { source: "project", trusted: true })).toThrow(/auth is only allowed in the global mcp\.json/);
    expect(() => one({ url: H, auth: { provider: "p" } }, { source: "project", trusted: true })).toThrow(TypeError);
  });
});

describe("getToolExposure", () => {
  const cfg = { exposure: "direct" as const, toolExposure: { "read_*": "hidden" as const, "read_file": "codemode" as const, "*_x.y": "deferred" as const, "*": "codemode" as const } };
  it("exact wins over patterns", () => expect(getToolExposure(cfg, "read_file")).toBe("codemode"));
  it("first pattern in insertion order wins", () => {
    expect(getToolExposure(cfg, "read_dir")).toBe("hidden");
    expect(getToolExposure(cfg, "a_x.y")).toBe("deferred");
    expect(getToolExposure(cfg, "zzz")).toBe("codemode");
  });
  it("escapes regex metacharacters", () => {
    const c = { exposure: "direct" as const, toolExposure: { "a.b*": "hidden" as const } };
    expect(getToolExposure(c, "a.bc")).toBe("hidden");
    expect(getToolExposure(c, "aXbc")).toBe("direct");
  });
  it("falls back to exposure", () => {
    expect(getToolExposure({ exposure: "deferred" }, "t")).toBe("deferred");
    expect(getToolExposure({ exposure: "direct", toolExposure: { a: "hidden" } }, "b")).toBe("direct");
  });
});

describe("isServerOverride / mcpServerNamespace", () => {
  it("detects overrides", () => {
    expect(isServerOverride({ enabled: false })).toBe(true);
    expect(isServerOverride({})).toBe(true);
    expect(isServerOverride({ command: "c" })).toBe(false);
    expect(isServerOverride({ url: H })).toBe(false);
    expect(isServerOverride({ type: "stdio" })).toBe(false);
    expect(isServerOverride([])).toBe(false);
    expect(isServerOverride(null)).toBe(false);
  });
  it("namespaces", () => {
    expect(mcpServerNamespace("my-srv")).toBe("my_srv");
    expect(mcpServerNamespace("my_srv")).toBe("my_srv");
  });
});

describe("loadLayeredMcpConfig", () => {
  const g = { autoEnableCodemode: false, mcpServers: { web: { url: H, headers: { A: "1" }, auth: { provider: "corp" }, oauth: { clientId: "id" } }, fs: { command: "srv", env: { K: "v" } } } };
  it("loads global only and ignores untrusted project", () => {
    const r = loadLayeredMcpConfig({ globalInput: g, projectInput: { autoEnableCodemode: true, mcpServers: { x: { command: "y" } } } });
    expect(r.servers.map((s) => s.name)).toEqual(["web", "fs"]);
    expect(r.autoEnableCodemode).toBe(false);
    expect(r.errors).toEqual([]);
  });
  it("empty inputs give empty result", () => {
    const r = loadLayeredMcpConfig({});
    expect(r).toEqual({ servers: [], errors: [] });
  });
  it("project override preserves global transport and credentials", () => {
    const r = loadLayeredMcpConfig({ globalInput: g, projectTrusted: true, projectInput: { autoEnableCodemode: true, mcpServers: { web: { enabled: false, exposure: "hidden", toolExposure: { "t*": "codemode" } } } } });
    const web = r.servers.find((s) => s.name === "web");
    expect(web).toMatchObject({ url: H, headers: { A: "1" }, auth: { provider: "corp" }, oauth: { clientId: "id" }, source: "global", enabled: false, exposure: "hidden", toolExposure: { "t*": "codemode" } });
    expect(r.autoEnableCodemode).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("override errors: missing base, extra keys, invalid value", () => {
    const r = loadLayeredMcpConfig({ globalInput: g, projectTrusted: true, projectInput: { mcpServers: { nope: { enabled: false }, fs: { enabled: false, env: { K: "x" } }, web: { exposure: "loud" } } } });
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/nope.*no global/);
    expect(r.errors[1]).toMatch(/fs.*env/);
    expect(r.errors[2]).toMatch(/exposure/);
    expect(r.servers.find((s) => s.name === "fs")?.env).toEqual({ K: "v" });
  });
  it("full project entry replaces global; auth in project is rejected", () => {
    const r = loadLayeredMcpConfig({ globalInput: g, projectTrusted: true, projectInput: { mcpServers: { fs: { command: "other" }, web: { url: H, auth: { provider: "x" } } } } });
    expect(r.servers.find((s) => s.name === "fs")).toMatchObject({ command: "other", source: "project" });
    expect(r.servers.find((s) => s.name === "web")).toMatchObject({ source: "global" });
    expect(r.errors.join()).toMatch(/auth is only allowed in the global mcp\.json/);
  });
  it("namespace collisions are reported and skipped", () => {
    const r = loadLayeredMcpConfig({ globalInput: { mcpServers: { "my-srv": { command: "a" }, my_srv: { command: "b" } } }, projectTrusted: true, projectInput: { mcpServers: { "fs-": { command: "c" }, "fs_": { command: "d" } } } });
    expect(r.servers.map((s) => s.name)).toEqual(["my-srv", "fs-"]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatch(/my_srv.*my-srv/);
  });
  it("invalid entries are skipped, valid ones kept; bad autoEnableCodemode recorded", () => {
    const r = loadLayeredMcpConfig({ globalInput: { autoEnableCodemode: "yes", mcpServers: { ok: { command: "c" }, bad: { command: "c", args: [1] }, "bad name": { command: "c" } } } });
    expect(r.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join()).toMatch(/autoEnableCodemode/);
    expect(r).not.toHaveProperty("autoEnableCodemode");
  });
  it("records malformed layers without throwing", () => {
    expect(loadLayeredMcpConfig({ globalInput: null }).errors[0]).toMatch(/mcpServers/);
  });
});

describe("resolveServerVariables", () => {
  it("readLegacyConfig keeps literal placeholders", () => {
    expect(one({ command: "c", env: { A: "${HOME}" } })?.env).toEqual({ A: "${HOME}" });
  });
  it("expands env, headers, oauth.clientSecret and resolves cwd", () => {
    const base = one({ url: H, headers: { Authorization: "Bearer ${TOK}", X: "${MISSING}-${1BAD}" }, oauth: { clientSecret: "${SEC}", clientId: "${TOK}" } });
    const r = resolveServerVariables(base!, { env: { TOK: "t", SEC: "s" } });
    expect(r.headers).toEqual({ Authorization: "Bearer t", X: "-${1BAD}" });
    expect(r.oauth).toEqual({ clientSecret: "s", clientId: "${TOK}" });
    expect(base?.headers?.Authorization).toBe("Bearer ${TOK}");
    const s = resolveServerVariables(one({ command: "c", env: { P: "${A}${B}" }, cwd: "sub" })!, { env: { A: "1", B: "2" }, cwd: "/root/proj" });
    expect(s.env).toEqual({ P: "12" });
    expect(s.cwd).toBe(resolve("/root/proj", "sub"));
    expect(resolveServerVariables(one({ command: "c", cwd: "/abs" })!, { cwd: "/x" }).cwd).toBe("/abs");
    expect(resolveServerVariables(one({ command: "c", cwd: "rel" })!, {}).cwd).toBe("rel");
  });
  it("never executes !cmd; optionally rejects it", () => {
    const cfg = one({ command: "c", env: { A: "!echo hi" } })!;
    expect(resolveServerVariables(cfg, { env: {} }).env).toEqual({ A: "!echo hi" });
    expect(() => resolveServerVariables(cfg, { disallowShellSubstitution: true })).toThrow(/shell/);
  });
});
