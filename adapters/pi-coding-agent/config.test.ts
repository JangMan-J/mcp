import { describe, expect, it } from "vitest";
import { readLegacyConfig } from "./config.ts";

const stdio = { mcpServers: { fs: { command: "srv", args: ["-x"], env: { A: "1" }, cwd: "/tmp" } } };
const http = { mcpServers: { web: { url: "https://example.test/mcp", headers: { H: "v" }, type: "streamable-http" } } };

describe("readLegacyConfig", () => {
  it("PICA-3: returns [] for untrusted project before inspecting input", () => {
    const trap = new Proxy({}, { get: () => { throw new Error("inspected"); } });
    expect(readLegacyConfig(trap, { source: "project" })).toEqual([]);
    expect(readLegacyConfig(trap, { source: "project", trusted: false })).toEqual([]);
    expect(readLegacyConfig(stdio, { source: "project" })).toEqual([]);
  });
  it("PICA-3: trusted project parses but is marked trusted/source", () => {
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
  it("PICA-11: read-only — input unchanged, so rollback is removing the adapter entry", () => {
    const raw = structuredClone(stdio);
    readLegacyConfig(raw, { source: "project", trusted: true });
    expect(raw).toEqual(stdio);
  });
});
