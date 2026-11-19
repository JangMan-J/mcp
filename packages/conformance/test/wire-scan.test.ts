import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(repoRoot, "scripts/wire-scan.mjs");
const SECRET = "s3cr3t-session-value-0xDEADBEEF";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "wire-scan-"));
  dirs.push(d);
  return d;
}

function write(dir: string, name: string, doc: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof doc === "string" ? doc : JSON.stringify(doc));
  return p;
}

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const okClient = {
  direction: "client",
  method: "POST",
  url: "http://127.0.0.1:1/mcp",
  headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28" },
  message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x", arguments: {} } },
};

describe("wire-scan CLI", () => {
  it("passes a clean transcript directory (recursive)", () => {
    const d = tmp();
    mkdirSync(join(d, "sub"));
    write(join(d, "sub"), "a.json", { fixture: "http/ok", frames: [okClient] });
    const r = run(d);
    expect(r.out).toContain("clean (1 transcripts, 1 client frames)");
    expect(r.code).toBe(0);
  });

  it("rejects missing input, missing path, and empty directories", () => {
    expect(run().code).toBe(1);
    const missing = run(join(tmp(), "nope"));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("not found");
    const empty = run(tmp());
    expect(empty.code).toBe(1);
    expect(empty.out).toContain("no evidence");
  });

  it("rejects malformed or empty evidence", () => {
    const cases: unknown[] = [
      "not json",
      [],
      { frames: [okClient] },
      { fixture: "f" },
      { fixture: "f", frames: [] },
      { fixture: "f", frames: [{ direction: "sideways", method: "POST" }] },
      { fixture: "f", frames: [{ direction: "client" }] },
      { fixture: "f", frames: [{ direction: "client", headers: "x" }] },
      { fixture: "f", frames: [{ direction: "server", message: { jsonrpc: "2.0", id: 1, result: {} } }] },
      { fixture: "f", incomplete: true, frames: [okClient] },
      { fixture: "f", incomplete: "yes", frames: [okClient] },
      { fixture: "f", frames: [okClient, { ...okClient, incomplete: true }] },
      { fixture: "f", frames: [{ direction: "client", method: "GET", url: "http://127.0.0.1:2/authorize" }] },
      { fixture: "f", frames: [{ ...okClient, endpoint: "bogus" }] },
    ];
    for (const c of cases) {
      const d = tmp();
      const p = write(d, "t.json", c);
      const r = run(p);
      expect(r.code, JSON.stringify(c)).toBe(1);
      expect(r.out).toContain("error");
    }
  });

  it.each([
    ["initialize", { ...okClient, message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } }],
    ["notifications/initialized", { ...okClient, message: { jsonrpc: "2.0", method: "notifications/initialized" } }],
    ["logging/setLevel", { ...okClient, message: { jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "debug" } } }],
    ["roots/list", { ...okClient, message: { jsonrpc: "2.0", id: 2, method: "roots/list" } }],
    ["sampling/createMessage", { ...okClient, message: { jsonrpc: "2.0", id: 2, method: "sampling/createMessage" } }],
    ["ping", { ...okClient, message: { jsonrpc: "2.0", id: 2, method: "ping" } }],
    ["io.modelcontextprotocol/logLevel", { ...okClient, message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { _meta: { "io.modelcontextprotocol/logLevel": "debug" } } } }],
    ["batch", { ...okClient, message: [okClient.message] }],
    ["includeContext", { ...okClient, message: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x", includeContext: "allServers" } } }],
    ["GET", { direction: "client", endpoint: "mcp", method: "GET", url: "http://127.0.0.1:1/mcp" }],
    ["DELETE", { direction: "client", endpoint: "mcp", method: "delete", url: "http://127.0.0.1:1/mcp" }],
    ["Dynamic Client Registration", { direction: "client", endpoint: "registration", method: "POST", url: "http://127.0.0.1:2/register", headers: { Authorization: "Bearer x" } }],
  ])("flags forbidden client construct %s", (needle, frame) => {
    const d = tmp();
    write(d, "t.json", { fixture: "bad/x", frames: [okClient, frame] });
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain("violation");
    expect(r.out).toContain(needle);
    expect(r.out).toContain("frame 1");
  });

  it.each(["Mcp-Session-Id", "last-event-id", "LAST-EVENT-ID"])("flags forbidden header %s without echoing its value", (name) => {
    const d = tmp();
    write(d, "t.json", { fixture: "bad/hdr", frames: [{ ...okClient, headers: { ...okClient.headers, [name]: SECRET } }] });
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`forbidden header '${name}'`);
    expect(r.out).not.toContain(SECRET);
  });

  it("never echoes any header value, even benign ones, on failure", () => {
    const d = tmp();
    write(d, "t.json", {
      fixture: "bad/mixed",
      frames: [{ ...okClient, method: "GET", headers: { Authorization: `Bearer ${SECRET}`, "Mcp-Session-Id": SECRET } }],
    });
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(SECRET);
  });

  it("does not flag deliberate server stimuli", () => {
    const d = tmp();
    write(d, "t.json", {
      fixture: "http/session-id-header-ignored",
      frames: [
        okClient,
        { direction: "server", headers: { "Mcp-Session-Id": SECRET }, message: { jsonrpc: "2.0", id: 1, result: {} } },
        { direction: "server", message: { jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } } },
        { direction: "server", message: { jsonrpc: "2.0", id: 9, method: "roots/list" } },
        { direction: "server", headers: { "Last-Event-ID": "7" }, method: "GET" },
      ],
    });
    const r = run(d);
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(SECRET);
  });

  it("reports incomplete evidence as an error even when frames are otherwise clean", () => {
    const d = tmp();
    write(d, "a.json", { fixture: "ok", frames: [okClient] });
    write(d, "b.json", { fixture: "partial", incomplete: true, frames: [okClient] });
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain("incomplete");
    expect(r.out).not.toContain("clean");
  });

  it("does not inspect tool arguments for includeContext or logLevel", () => {
    const d = tmp();
    write(d, "t.json", {
      fixture: "tools/args",
      frames: [
        {
          ...okClient,
          message: {
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
              name: "configure",
              arguments: { includeContext: "allServers", "io.modelcontextprotocol/logLevel": "debug", _meta: { "io.modelcontextprotocol/logLevel": "x" }, method: "roots/list" },
              _meta: { progressToken: 1 },
            },
          },
        },
      ],
    });
    const r = run(d);
    expect(r.out).toContain("clean");
    expect(r.code).toBe(0);
  });

  it("allows GET on OAuth endpoints but bans it on the MCP endpoint resolved via mcpEndpoint", () => {
    const d = tmp();
    write(d, "ok.json", {
      fixture: "auth/discovery",
      mcpEndpoint: "http://127.0.0.1:1/mcp",
      frames: [
        { direction: "client", endpoint: "oauth", method: "GET", url: "http://127.0.0.1:1/.well-known/oauth-protected-resource" },
        { direction: "client", endpoint: "oauth", method: "GET", url: "http://127.0.0.1:2/authorize?response_type=code&state=s" },
        okClient,
      ],
    });
    expect(run(d).code).toBe(0);
    const e = tmp();
    write(e, "bad.json", {
      fixture: "http/get",
      mcpEndpoint: "http://127.0.0.1:1/mcp/",
      frames: [{ direction: "client", method: "GET", url: "http://127.0.0.1:1/mcp" }],
    });
    const r = run(e);
    expect(r.code).toBe(1);
    expect(r.out).toContain("forbidden HTTP method 'GET' on MCP endpoint");
  });

  it.each([
    ["access_token", "http://127.0.0.1:1/mcp?access_token=" + SECRET],
    ["client_secret", "http://127.0.0.1:2/token?client_secret=" + SECRET],
    ["userinfo", `http://user:${SECRET}@127.0.0.1:1/mcp`],
  ])("flags credential leakage in URL (%s) without echoing it", (needle, url) => {
    const d = tmp();
    write(d, "t.json", { fixture: "auth/leak", frames: [{ ...okClient, url }] });
    const r = run(d);
    expect(r.code).toBe(1);
    expect(r.out).toContain(needle);
    expect(r.out).not.toContain(SECRET);
  });

  it("states the DCR detection limitation on a clean run", () => {
    const d = tmp();
    write(d, "t.json", { fixture: "ok", frames: [okClient] });
    expect(run(d).out).toContain("limitation: DCR detection relies on endpoint:'registration'");
  });
});
