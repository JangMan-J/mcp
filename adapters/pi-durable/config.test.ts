import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServers, normalizeServer, readLegacyConfig } from "./config.js";

const read = (servers: Record<string, unknown>, opts?: Parameters<typeof readLegacyConfig>[1]) =>
  readLegacyConfig({ mcpServers: servers }, opts);

describe("transport", () => {
  it("stdio: command/args/cwd/env", () => {
    expect(read({ s: { command: "node", args: ["x.js"], cwd: "sub", env: { A: "1" } } })[0]).toMatchObject({
      name: "s", transport: "stdio", command: "node", args: ["x.js"], cwd: "sub", env: { A: "1" },
      source: "global", trusted: true, enabled: true, exposure: "direct",
    });
  });
  it("streamable-http: url/headers; type alone or url alone selects http", () => {
    const [a, b] = read({
      a: { type: "streamable-http", url: "https://x.test/mcp", headers: { H: "v" } },
      b: { url: "http://127.0.0.1:9/mcp" },
    });
    expect(a).toMatchObject({ transport: "http", url: "https://x.test/mcp", headers: { H: "v" } });
    expect(a).not.toHaveProperty("command");
    expect(b).toMatchObject({ transport: "http" });
  });
  it("rejects sse, mixed command+url, missing url/command, bad scheme", () => {
    expect(() => read({ s: { type: "sse", url: "https://x.test" } })).toThrow(/SSE/);
    expect(() => read({ s: { command: "c", url: "https://x.test" } })).toThrow(/either command or url/);
    expect(() => read({ s: { type: "http" } })).toThrow(/url is required/);
    expect(() => read({ s: {} })).toThrow(/command is required/);
    expect(() => read({ s: { url: "ftp://x.test" } })).toThrow(/http: or https:/);
  });
});

describe("auth", () => {
  const url = "https://x.test/mcp";
  it("keeps auth/oauth/clientCredentials/enterpriseAuth for trusted global http", () => {
    const [s] = read({
      a: { url, auth: { provider: "corp", extra: 1 } },
      o: { url, oauth: { clientId: "id", clientRegistration: "dcr" } },
      c: { url, clientCredentials: { clientId: "id", clientSecret: "s" } },
      e: { url, enterpriseAuth: { idp: "x" } },
    });
    expect(s!.auth).toEqual({ provider: "corp" });
    const all = read({ o: { url, oauth: { clientId: "id" } }, c: { url, clientCredentials: { clientSecret: "s" } } });
    expect(all[0]!.oauth).toEqual({ clientId: "id" });
    expect(all[1]!.clientCredentials).toEqual({ clientSecret: "s" });
  });
  it("auth blocks are global-only, http-only, https-or-loopback", () => {
    expect(() => read({ a: { url, auth: { provider: "p" } } }, { source: "project", trusted: true })).toThrow(/global mcp.json/);
    expect(() => read({ a: { url, auth: { provider: "p" } } }, { source: "dynamic" })).toThrow(/global mcp.json/);
    expect(() => read({ a: { command: "c", clientCredentials: {} } })).toThrow(/requires an HTTP server/);
    expect(() => read({ a: { url: "http://x.test", enterpriseAuth: {} } })).toThrow(/https: or loopback/);
    expect(() => read({ a: { url, auth: { provider: "" } } })).toThrow(/auth.provider/);
  });
  it("validates oauth fields", () => {
    expect(() => read({ o: { url, oauth: { callbackPort: 0 } } })).toThrow(/callbackPort/);
    expect(() => read({ o: { url, oauth: { callbackUrl: "https://evil.test/cb" } } })).toThrow(/loopback/);
    expect(() => read({ o: { url, oauth: { clientRegistration: "cimd", clientId: "x" } } })).toThrow(/cimd/);
  });
  it("untrusted project config is ignored before inspection (PICA-3)", () => {
    expect(readLegacyConfig("garbage", { source: "project" })).toEqual([]);
  });
});

describe("exposure", () => {
  it("defaults direct, maps codemode-deferred alias, keeps wildcard toolExposure keys verbatim", () => {
    const [s] = read({ s: { command: "c", exposure: "codemode-deferred",
      toolExposure: { "*": "hidden", "read_*": "deferred", exact: "codemode-deferred" } } });
    expect(s!.exposure).toBe("codemode");
    expect(s!.toolExposure).toEqual({ "*": "hidden", "read_*": "deferred", exact: "codemode" });
    expect(read({ s: { command: "c" } })[0]!.exposure).toBe("direct");
  });
  it("rejects unknown exposure values", () => {
    expect(() => read({ s: { command: "c", exposure: "loud" } })).toThrow(/exposure is invalid/);
    expect(() => read({ s: { command: "c", toolExposure: { "*": "loud" } } })).toThrow(/toolExposure is invalid/);
  });
});

describe("subscribe, inheritEnv, timeouts", () => {
  it("subscribe entries are validated and copied", () => {
    const [s] = read({ s: { command: "c", subscribe: [{ name: "r", delivery: "poll", holdSettle: true, arguments: { q: 1 }, maxAgeMs: 5 }, { name: "b" }] } });
    expect(s!.subscribe).toEqual([{ name: "r", delivery: "poll", holdSettle: true, arguments: { q: 1 }, maxAgeMs: 5 }, { name: "b" }]);
    expect(() => read({ s: { command: "c", subscribe: [{ name: "r", delivery: "x" }] } })).toThrow(/delivery/);
    expect(() => read({ s: { command: "c", subscribe: [{ name: " " }] } })).toThrow(/name/);
    expect(() => read({ s: { command: "c", subscribe: {} } })).toThrow(/array/);
  });
  it("inheritEnv: boolean or string[], omitted when absent", () => {
    const [t, l, n] = read({ t: { command: "c", inheritEnv: true }, l: { command: "c", inheritEnv: ["PATH"] }, n: { command: "c" } });
    expect(t!.inheritEnv).toBe(true);
    expect(l!.inheritEnv).toEqual(["PATH"]);
    expect(n).not.toHaveProperty("inheritEnv");
    expect(() => read({ s: { command: "c", inheritEnv: [1] } })).toThrow(/inheritEnv/);
  });
  it("timeout (s) and timeoutMs are independent, finite, positive", () => {
    expect(read({ s: { command: "c", timeout: 5, timeoutMs: 250 } })[0]).toMatchObject({ timeout: 5, timeoutMs: 250 });
    for (const bad of [0, -1, Infinity, "5"]) {
      expect(() => read({ s: { command: "c", timeout: bad } })).toThrow(/timeout/);
      expect(() => read({ s: { command: "c", timeoutMs: bad } })).toThrow(/timeoutMs/);
    }
  });
});

describe("replay config", () => {
  const replay = { readOnlyTools: ["search"], toolOverrides: { write: "replay", secret: "interrupt" }, acceptDuplicate: true, instructions: "be nice" };
  it("is preserved by readLegacyConfig and normalizeServer", () => {
    expect(read({ s: { command: "c", ...replay } })[0]).toMatchObject(replay);
    expect(normalizeServer("s", { command: "c", ...replay })).toMatchObject(replay);
  });
  it("is validated", () => {
    expect(() => read({ s: { command: "c", readOnlyTools: "search" } })).toThrow(/readOnlyTools/);
    expect(() => read({ s: { command: "c", toolOverrides: { w: "always" } } })).toThrow(/toolOverrides/);
    expect(() => read({ s: { command: "c", acceptDuplicate: "yes" } })).toThrow(/acceptDuplicate/);
  });
  it("loadServers keeps replay config, drops disabled, resolves cwd and ${VAR}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-durable-config-"));
    const path = join(dir, "mcp.json");
    process.env.PI_DURABLE_CONFIG_TEST = "v";
    await writeFile(path, JSON.stringify({ mcpServers: {
      on: { command: "c", cwd: "sub", env: { A: "${PI_DURABLE_CONFIG_TEST}", B: "!echo hi" }, ...replay },
      off: { command: "c", enabled: false },
    } }));
    await expect(loadServers(path)).rejects.toThrow(/shell substitution/);
    await writeFile(path, JSON.stringify({ mcpServers: {
      on: { command: "c", cwd: "sub", env: { A: "${PI_DURABLE_CONFIG_TEST}" }, ...replay },
      off: { command: "c", enabled: false },
    } }));
    const servers = await loadServers(path);
    expect(servers.map((s) => s.name)).toEqual(["on"]);
    expect(servers[0]).toMatchObject({ cwd: join(dir, "sub"), env: { A: "v" }, ...replay });
    delete process.env.PI_DURABLE_CONFIG_TEST;
  });
});

describe("normalizeServer (direct descriptors)", () => {
  it("defaults to trusted global", () => {
    expect(normalizeServer("s", { command: "c" })).toMatchObject({ source: "global", trusted: true });
  });
  it("honors explicit trusted/source instead of forcing Pi-global trust", () => {
    expect(normalizeServer("s", { command: "c", trusted: false })).toMatchObject({ source: "global", trusted: false });
    expect(normalizeServer("s", { command: "c", source: "dynamic" })).toMatchObject({ source: "dynamic", trusted: true });
    expect(normalizeServer("s", { command: "c", source: "project", trusted: true })).toMatchObject({ source: "project", trusted: true });
    expect(() => normalizeServer("s", { url: "https://x.test", trusted: false, auth: { provider: "p" } })).toThrow(/global mcp.json/);
    expect(() => normalizeServer("s", { url: "https://x.test", source: "dynamic", oauth: {}, clientCredentials: {} })).toThrow(/global mcp.json/);
  });
  it("rejects untrusted project and invalid trust params", () => {
    expect(() => normalizeServer("s", { command: "c", source: "project" })).toThrow(/untrusted project/);
    expect(() => normalizeServer("s", { command: "c", source: "elsewhere" })).toThrow(/source is invalid/);
    expect(() => normalizeServer("s", { command: "c", trusted: "yes" })).toThrow(/trusted must be boolean/);
  });
});
