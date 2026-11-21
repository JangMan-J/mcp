import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@mcp-client/core", async () => {
  const path = "../../packages/core/src/index.ts";
  return await import(path as string);
});
vi.mock("@mcp-client/ops", async () => {
  const path = "../../packages/ops/src/index.ts";
  return await import(path as string);
});

import {
  JSONRPC_VERSION,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportCall,
  type TransportDiagnostic,
} from "@mcp-client/core";
import { runMcpCli } from "./bin/mcp-cli.ts";

const scratchDirs: string[] = [];
async function makeScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pica-cli-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const emptyAsyncIterable = <T>(): AsyncIterable<T> => ({
  async *[Symbol.asyncIterator]() {},
});

function createMockTransport(
  handler: (msg: JsonRpcRequest, ctx: TransportCall) => ExchangeEnd | Promise<ExchangeEnd>,
): Transport & { readonly closed: ReturnType<typeof vi.fn> } {
  const closed = vi.fn(async () => {});
  return {
    binding: "stdio",
    closed,
    diagnostics: emptyAsyncIterable<TransportDiagnostic>(),
    start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
      return {
        notifications: emptyAsyncIterable<JsonRpcNotification>(),
        done: Promise.resolve().then(() => handler(msg, ctx)),
      };
    },
    async notify() {},
    close: closed,
  };
}

async function runCli(
  argv: readonly string[],
  opts: {
    configDir?: string;
    createTransport?: (d: { name: string }) => Transport;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runMcpCli(argv, {
    ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}),
    ...(opts.createTransport ? { createTransport: opts.createTransport } : {}),
    stdout: (s) => { stdout += s; },
    stderr: (s) => { stderr += s; },
  });
  return { code, stdout, stderr };
}

it("lists configured servers with servers/list and --json without modifying legacy files", async () => {
  const dir = await makeScratchDir();
  const mcpPath = join(dir, "mcp.json");
  const authPath = join(dir, "mcp-auth.json");
  const rawConfig = JSON.stringify(
    {
      mcpServers: {
        docs: { url: "https://docs.example.invalid/mcp", description: "Docs server", exposure: "deferred" },
        files: { command: "node", args: ["server.js"], enabled: false },
      },
    },
    null,
    2,
  );
  await writeFile(mcpPath, rawConfig);
  await writeFile(authPath, "untouched-auth\n");

  const textRes = await runCli(["--config-dir", dir, "servers"]);
  expect(textRes.code).toBe(0);
  expect(textRes.stderr).toBe("");
  expect(textRes.stdout).toContain("docs (http, enabled, deferred) - Docs server");
  expect(textRes.stdout).toContain("files (stdio, disabled, direct)");

  const jsonRes = await runCli(["list", "--json", "--config-dir", dir]);
  expect(jsonRes.code).toBe(0);
  expect(JSON.parse(jsonRes.stdout)).toEqual([
    { name: "docs", transport: "http", enabled: true, exposure: "deferred", description: "Docs server" },
    { name: "files", transport: "stdio", enabled: false, exposure: "direct" },
  ]);

  expect(await readFile(mcpPath, "utf8")).toBe(rawConfig);
  expect(await readFile(authPath, "utf8")).toBe("untouched-auth\n");
});

it("prints help with --help or empty argv", async () => {
  const res1 = await runCli(["--help"]);
  expect(res1.code).toBe(0);
  expect(res1.stdout).toContain("Usage: mcp-cli");

  const res2 = await runCli([]);
  expect(res2.code).toBe(0);
  expect(res2.stdout).toContain("Commands:");
});

it("runs discover, tools, resources, templates, read, and prompts against MCP 2026-07-28 JSON-RPC", async () => {
  const dir = await makeScratchDir();
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake" } } }));

  const seenTimeouts: number[] = [];
  const transport = createMockTransport((msg, ctx) => {
    seenTimeouts.push(ctx.timeoutMs);
    switch (msg.method) {
      case "server/discover":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: {
              resultType: "complete",
              cacheScope: "public",
              ttlMs: 60_000,
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {}, resources: {}, prompts: {} },
              instructions: "Use carefully.",
            },
          },
        };
      case "tools/list":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: {
              tools: [
                { name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
              ],
            },
          },
        };
      case "resources/list":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: { resources: [{ uri: "file:///readme.md", name: "README" }] },
          },
        };
      case "resources/templates/list":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "File" }] },
          },
        };
      case "resources/read":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: { contents: [{ uri: "file:///readme.md", text: "Hello MCP" }] },
          },
        };
      case "prompts/list":
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            result: { prompts: [{ name: "summarize", description: "Summarize text" }] },
          },
        };
      default:
        return {
          kind: "response",
          message: {
            jsonrpc: JSONRPC_VERSION,
            id: msg.id,
            error: { code: -32601, message: `Method not found: ${msg.method}` },
          },
        };
    }
  });

  const discoverRes = await runCli(["discover", "srv", "--timeout", "1500"], { configDir: dir, createTransport: () => transport });
  expect(discoverRes.code).toBe(0);
  expect(discoverRes.stdout).toContain("2026-07-28");
  expect(discoverRes.stdout).toContain("tools, resources, prompts");
  expect(discoverRes.stdout).toContain("Use carefully.");
  expect(seenTimeouts[0]).toBe(1500);

  const discoverJson = await runCli(["discover", "srv", "--json"], { configDir: dir, createTransport: () => transport });
  expect(discoverJson.code).toBe(0);
  expect(JSON.parse(discoverJson.stdout).supportedVersions).toEqual(["2026-07-28"]);

  const toolsRes = await runCli(["tools", "srv"], { configDir: dir, createTransport: () => transport });
  expect(toolsRes.code).toBe(0);
  expect(toolsRes.stdout).toContain("echo: Echo input");

  const toolsJson = await runCli(["tools", "srv", "--json"], { configDir: dir, createTransport: () => transport });
  expect(toolsJson.code).toBe(0);
  expect(JSON.parse(toolsJson.stdout)[0].name).toBe("echo");

  const resList = await runCli(["resources", "srv"], { configDir: dir, createTransport: () => transport });
  expect(resList.code).toBe(0);
  expect(resList.stdout).toContain("file:///readme.md (README)");

  const tmplList = await runCli(["templates", "srv"], { configDir: dir, createTransport: () => transport });
  expect(tmplList.code).toBe(0);
  expect(tmplList.stdout).toContain("file:///{path} (File)");

  const readRes = await runCli(["read", "srv", "file:///readme.md"], { configDir: dir, createTransport: () => transport });
  expect(readRes.code).toBe(0);
  expect(readRes.stdout).toContain("Hello MCP");

  const promptsRes = await runCli(["prompts", "srv"], { configDir: dir, createTransport: () => transport });
  expect(promptsRes.code).toBe(0);
  expect(promptsRes.stdout).toContain("summarize: Summarize text");

  expect(transport.closed).toHaveBeenCalledTimes(8);
});

it("handles call ok (0), tool-isError (2), uncertain-write (3), and jsonrpc-error (1)", async () => {
  const dir = await makeScratchDir();
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "fake" } } }));

  const okTransport = createMockTransport((msg) => ({
    kind: "response",
    message: {
      jsonrpc: JSONRPC_VERSION,
      id: msg.id,
      result: { content: [{ type: "text", text: `called:${JSON.stringify(msg.params?.["arguments"])}` }] },
    },
  }));
  const okRes = await runCli(["call", "srv", "echo", '{"a":1}'], { configDir: dir, createTransport: () => okTransport });
  expect(okRes.code).toBe(0);
  expect(okRes.stdout.trim()).toBe('called:{"a":1}');
  expect(okTransport.closed).toHaveBeenCalledTimes(1);

  const isErrTransport = createMockTransport((msg) => ({
    kind: "response",
    message: {
      jsonrpc: JSONRPC_VERSION,
      id: msg.id,
      result: { isError: true, content: [{ type: "text", text: "bad input" }] },
    },
  }));
  const isErrRes = await runCli(["call", "srv", "echo"], { configDir: dir, createTransport: () => isErrTransport });
  expect(isErrRes.code).toBe(2);
  expect(isErrRes.stderr).toContain("bad input");
  expect(isErrTransport.closed).toHaveBeenCalledTimes(1);

  const uncertainTransport = createMockTransport(() => ({
    kind: "failure",
    failure: { kind: "stream-broken", message: "EOF mid-response" },
    delivery: "maybe-delivered",
  }));
  const uncertainRes = await runCli(["call", "srv", "write_item", '{"id":9}'], {
    configDir: dir,
    createTransport: () => uncertainTransport,
  });
  expect(uncertainRes.code).toBe(3);
  expect(uncertainRes.stderr).toContain("Uncertain write: may or may not have run; do not retry blindly");
  expect(uncertainTransport.closed).toHaveBeenCalledTimes(1);

  const rpcErrTransport = createMockTransport((msg) => ({
    kind: "response",
    message: {
      jsonrpc: JSONRPC_VERSION,
      id: msg.id,
      error: { code: -32602, message: "Invalid params" },
    },
  }));
  const rpcErrRes = await runCli(["call", "srv", "echo"], { configDir: dir, createTransport: () => rpcErrTransport });
  expect(rpcErrRes.code).toBe(1);
  expect(rpcErrRes.stderr).toContain("-32602");
  expect(rpcErrTransport.closed).toHaveBeenCalledTimes(1);

  const badJsonRes = await runCli(["call", "srv", "echo", "{not-json"], {
    configDir: dir,
    createTransport: () => okTransport,
  });
  expect(badJsonRes.code).toBe(1);
  expect(badJsonRes.stderr).toContain("Invalid JSON arguments");
  expect(okTransport.closed).toHaveBeenCalledTimes(2);
});

it("rejects unknown or disabled servers without creating a transport and closes on failure", async () => {
  const dir = await makeScratchDir();
  await writeFile(
    join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        off: { command: "fake", enabled: false },
        on: { command: "fake", enabled: true },
      },
    }),
  );
  const createTransport = vi.fn(() =>
    createMockTransport(() => {
      throw new Error("boom");
    }),
  );

  const unknownRes = await runCli(["tools", "missing"], { configDir: dir, createTransport });
  expect(unknownRes.code).toBe(1);
  expect(unknownRes.stderr).toContain("Unknown MCP server: missing");
  expect(createTransport).not.toHaveBeenCalled();

  const disabledRes = await runCli(["tools", "off"], { configDir: dir, createTransport });
  expect(disabledRes.code).toBe(1);
  expect(disabledRes.stderr).toContain('MCP server "off" is disabled');
  expect(createTransport).not.toHaveBeenCalled();

  const failRes = await runCli(["tools", "on"], { configDir: dir, createTransport });
  expect(failRes.code).toBe(1);
  expect(failRes.stderr).toContain("boom");
  const created = createTransport.mock.results[0]?.value as ReturnType<typeof createMockTransport>;
  expect(created.closed).toHaveBeenCalledTimes(1);
});
