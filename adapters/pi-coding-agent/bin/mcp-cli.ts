#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  McpClient,
  type DiscoverResult,
  type Outcome,
  type RequestOptions,
  type Transport,
} from "@mcp-client/core";
import { createOps } from "@mcp-client/ops";
import { readLegacyConfig, type LegacyServerConfig, type LegacySource } from "../config.ts";

export interface McpCliDeps {
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly configDir?: string;
  readonly project?: { readonly configPath: string; readonly trusted: boolean };
  readonly createTransport?: (descriptor: LegacyServerConfig) => Transport | Promise<Transport>;
  readonly signal?: AbortSignal;
}

interface ParsedArgs {
  readonly help: boolean;
  readonly json: boolean;
  readonly configDir?: string;
  readonly timeoutMs?: number;
  readonly positionals: readonly string[];
}

const HELP_TEXT = `Usage: mcp-cli [options] <command> [args...]

Options:
  --config-dir <dir>  Config directory containing mcp.json
  --json              Emit JSON output
  --timeout <ms>      Request timeout in milliseconds
  -h, --help          Show this help message

Commands:
  servers | list                 List configured MCP servers
  discover <server>              Run server/discover and print capabilities
  tools <server>                 List tools on <server>
  call <server> <tool> [args]    Call a tool with optional JSON object args
  resources <server>             List resources on <server>
  templates <server>             List resource templates on <server>
  read <server> <uri>            Read a resource by URI
  prompts <server>               List prompts on <server>
`;

const UNCERTAIN_WRITE_WARNING =
  "Uncertain write: may or may not have run; do not retry blindly. Check its effects first.";

function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let json = false;
  let configDir: string | undefined;
  let timeoutMs: number | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--config-dir") {
      const val = argv[++i];
      if (val === undefined || val === "") {
        throw new Error("--config-dir requires a directory argument");
      }
      configDir = val;
    } else if (arg.startsWith("--config-dir=")) {
      const val = arg.slice("--config-dir=".length);
      if (val === "") throw new Error("--config-dir requires a directory argument");
      configDir = val;
    } else if (arg === "--timeout") {
      const val = argv[++i];
      if (val === undefined) throw new Error("--timeout requires a millisecond value");
      timeoutMs = parsePositiveMs(val);
    } else if (arg.startsWith("--timeout=")) {
      timeoutMs = parsePositiveMs(arg.slice("--timeout=".length));
    } else if (arg.startsWith("-") && positionals.length === 0) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return {
    help,
    json,
    ...(configDir !== undefined ? { configDir } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    positionals,
  };
}

function parsePositiveMs(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds, got "${raw}"`);
  }
  return n;
}

function readConfigFile(path: string, source: LegacySource): LegacyServerConfig[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return readLegacyConfig(JSON.parse(text), { source, trusted: true });
}

function loadServers(
  configDir: string,
  project?: { readonly configPath: string; readonly trusted: boolean },
): Map<string, LegacyServerConfig> {
  const descriptors = readConfigFile(resolve(configDir, "mcp.json"), "global");
  if (project?.trusted === true) {
    descriptors.push(...readConfigFile(project.configPath, "project"));
  }
  const map = new Map<string, LegacyServerConfig>();
  for (const d of descriptors) {
    map.set(d.name, d);
  }
  return map;
}

async function defaultCreateTransport(descriptor: LegacyServerConfig): Promise<Transport> {
  if (descriptor.transport === "http") {
    const modName = "@mcp-client/transport-http";
    const mod = (await import(modName as string)) as {
      HttpTransport: new (opts: {
        readonly url: string;
        readonly extraHeaders?: Readonly<Record<string, string>>;
      }) => Transport;
    };
    return new mod.HttpTransport({
      url: descriptor.url!,
      ...(descriptor.headers ? { extraHeaders: descriptor.headers } : {}),
    });
  }
  const modName = "@mcp-client/transport-stdio";
  const mod = (await import(modName as string)) as {
    StdioTransport: new (opts: {
      readonly command: string;
      readonly args?: readonly string[];
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
    }) => Transport;
  };
  return new mod.StdioTransport({
    command: descriptor.command!,
    ...(descriptor.args ? { args: descriptor.args } : {}),
    ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
    ...(descriptor.env ? { env: descriptor.env } : {}),
  });
}

function extractTextFromResult(result: unknown): string {
  if (result && typeof result === "object" && "content" in result && Array.isArray(result.content)) {
    const lines: string[] = [];
    for (const block of result.content) {
      if (block && typeof block === "object" && "type" in block) {
        if (block.type === "text" && "text" in block && typeof block.text === "string") {
          lines.push(block.text);
        } else {
          lines.push(JSON.stringify(block));
        }
      }
    }
    return lines.join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function formatOutcomeError(outcome: Exclude<Outcome<unknown>, { readonly kind: "ok" }>): string {
  switch (outcome.kind) {
    case "tool-isError":
      return extractTextFromResult(outcome.result) || "Tool returned an error (isError: true)";
    case "uncertain-write":
      return `${UNCERTAIN_WRITE_WARNING} (method=${outcome.uncertain.method}, evidence=${outcome.uncertain.evidence})`;
    case "jsonrpc-error":
      return `JSON-RPC error ${outcome.code}: ${outcome.message}`;
    case "transport-failure":
      return `Transport failure (${outcome.failure.kind}): ${outcome.failure.message}`;
    case "cancelled":
      return `Cancelled (${outcome.phase}, wasSent=${String(outcome.wasSent)})`;
    case "mrtr-interim":
      return "MCP error (mrtr-interim): interactive input required";
    case "task-handle":
      return `MCP error (task-handle): ${JSON.stringify(outcome.handle)}`;
    default:
      return `MCP error (${outcome.kind}): ${JSON.stringify(outcome.detail)}`;
  }
}

function handleFailureOutcome(
  outcome: Exclude<Outcome<unknown>, { readonly kind: "ok" }>,
  json: boolean,
  out: (s: string) => void,
  err: (s: string) => void,
): number {
  if (outcome.kind === "tool-isError") {
    if (json) {
      out(`${JSON.stringify(outcome.result, null, 2)}\n`);
    } else {
      err(`${formatOutcomeError(outcome)}\n`);
    }
    return 2;
  }
  if (outcome.kind === "uncertain-write") {
    err(`${formatOutcomeError(outcome)}\n`);
    if (json) {
      out(`${JSON.stringify({ kind: outcome.kind, uncertain: outcome.uncertain }, null, 2)}\n`);
    }
    return 3;
  }
  err(`${formatOutcomeError(outcome)}\n`);
  return 1;
}

function printDiscover(result: DiscoverResult, json: boolean, out: (s: string) => void): void {
  if (json) {
    out(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  out(`Protocol versions: ${result.supportedVersions.join(", ") || "(none)"}\n`);
  const capKeys = Object.keys(result.capabilities);
  out(`Capabilities: ${capKeys.length > 0 ? capKeys.join(", ") : "(none)"}\n`);
  if (result.instructions) {
    out(`Instructions: ${result.instructions}\n`);
  }
}

export async function runMcpCli(argv: readonly string[], deps: McpCliDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  if (parsed.help || parsed.positionals.length === 0) {
    out(HELP_TEXT);
    return 0;
  }

  const configDir =
    parsed.configDir ??
    deps.configDir ??
    process.env["PI_CODING_AGENT_DIR"] ??
    join(homedir(), ".pi/agent");

  let servers: Map<string, LegacyServerConfig>;
  try {
    servers = loadServers(configDir, deps.project);
  } catch (error) {
    err(`Failed to read MCP config: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const [subcommand, ...rest] = parsed.positionals;

  if (subcommand === "servers" || subcommand === "list") {
    const entries = Array.from(servers.values(), (s) => ({
      name: s.name,
      transport: s.transport,
      enabled: s.enabled,
      exposure: s.exposure,
      ...(s.description !== undefined ? { description: s.description } : {}),
    }));
    if (parsed.json) {
      out(`${JSON.stringify(entries, null, 2)}\n`);
    } else if (entries.length === 0) {
      out("No MCP servers configured.\n");
    } else {
      for (const s of entries) {
        const status = s.enabled ? "enabled" : "disabled";
        const desc = s.description ? ` - ${s.description}` : "";
        out(`${s.name} (${s.transport}, ${status}, ${s.exposure})${desc}\n`);
      }
    }
    return 0;
  }

  const serverName = rest[0];
  if (!serverName) {
    err(`Subcommand "${subcommand}" requires a <server> argument\n`);
    return 1;
  }

  const descriptor = servers.get(serverName);
  if (!descriptor) {
    err(`Unknown MCP server: ${serverName}\n`);
    return 1;
  }
  if (!descriptor.enabled) {
    err(`MCP server "${serverName}" is disabled\n`);
    return 1;
  }

  const timeoutMs =
    parsed.timeoutMs ??
    (descriptor.timeout !== undefined ? descriptor.timeout * 1000 : undefined);
  const reqOpts: RequestOptions = {
    ...(deps.signal ? { signal: deps.signal } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };

  let transport: Transport | undefined;
  let client: McpClient | undefined;
  try {
    const factory = deps.createTransport ?? defaultCreateTransport;
    transport = await factory(descriptor);
    client = new McpClient({
      transport,
      server: { key: descriptor.name },
      ...(timeoutMs !== undefined ? { defaults: { timeoutMs } } : {}),
    });
    const ops = createOps(client, { serverTrusted: descriptor.trusted });

    switch (subcommand) {
      case "discover": {
        const outcome = await client.discover(reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        printDiscover(outcome.value, parsed.json, out);
        return 0;
      }

      case "tools": {
        const outcome = await ops.tools.listAll(reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.items.map((t) => t.tool), null, 2)}\n`);
        } else if (outcome.value.items.length === 0) {
          out("No tools available.\n");
        } else {
          for (const entry of outcome.value.items) {
            const desc = typeof entry.tool["description"] === "string" ? `: ${entry.tool["description"]}` : "";
            out(`${entry.name}${desc}\n`);
          }
        }
        return 0;
      }

      case "call": {
        const toolName = rest[1];
        if (!toolName) {
          err("Subcommand \"call\" requires <server> <tool> [json-args]\n");
          return 1;
        }
        let toolArgs: Record<string, unknown> = {};
        if (rest[2] !== undefined) {
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(rest[2]);
          } catch (error) {
            err(`Invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
          }
          if (typeof parsedJson !== "object" || parsedJson === null || Array.isArray(parsedJson)) {
            err("Tool arguments must be a JSON object\n");
            return 1;
          }
          toolArgs = parsedJson as Record<string, unknown>;
        }
        const outcome = await ops.tools.call(toolName, toolArgs, reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.raw, null, 2)}\n`);
        } else {
          const text = extractTextFromResult(outcome.value.raw);
          if (text) {
            out(`${text}\n`);
          } else if (outcome.value.structuredContent !== undefined) {
            out(`${JSON.stringify(outcome.value.structuredContent, null, 2)}\n`);
          }
        }
        return 0;
      }

      case "resources": {
        const outcome = await ops.resources.listAll(reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.items.map((r) => r.raw), null, 2)}\n`);
        } else if (outcome.value.items.length === 0) {
          out("No resources available.\n");
        } else {
          for (const item of outcome.value.items) {
            const uri = typeof item.raw["uri"] === "string" ? item.raw["uri"] : "(unknown)";
            const name = typeof item.raw["name"] === "string" ? ` (${item.raw["name"]})` : "";
            out(`${uri}${name}\n`);
          }
        }
        return 0;
      }

      case "templates": {
        const outcome = await ops.resources.listAllTemplates(reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.items.map((r) => r.raw), null, 2)}\n`);
        } else if (outcome.value.items.length === 0) {
          out("No resource templates available.\n");
        } else {
          for (const item of outcome.value.items) {
            const uriTemplate =
              typeof item.raw["uriTemplate"] === "string" ? item.raw["uriTemplate"] : "(unknown)";
            const name = typeof item.raw["name"] === "string" ? ` (${item.raw["name"]})` : "";
            out(`${uriTemplate}${name}\n`);
          }
        }
        return 0;
      }

      case "read": {
        const uri = rest[1];
        if (!uri) {
          err("Subcommand \"read\" requires <server> <uri>\n");
          return 1;
        }
        const outcome = await ops.resources.read(uri, reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.raw, null, 2)}\n`);
        } else {
          for (const entry of outcome.value.contents) {
            if (entry.text !== undefined) {
              out(`${entry.text}\n`);
            } else if (entry.blob !== undefined) {
              out(`[blob ${entry.mimeType ?? "application/octet-stream"}: ${entry.blob.length} base64 chars]\n`);
            }
          }
        }
        return 0;
      }

      case "prompts": {
        const outcome = await ops.prompts.listAll(reqOpts);
        if (outcome.kind !== "ok") {
          return handleFailureOutcome(outcome, parsed.json, out, err);
        }
        if (parsed.json) {
          out(`${JSON.stringify(outcome.value.items, null, 2)}\n`);
        } else if (outcome.value.items.length === 0) {
          out("No prompts available.\n");
        } else {
          for (const prompt of outcome.value.items) {
            const name = typeof prompt["name"] === "string" ? prompt["name"] : "(unknown)";
            const desc = typeof prompt["description"] === "string" ? `: ${prompt["description"]}` : "";
            out(`${name}${desc}\n`);
          }
        }
        return 0;
      }

      default:
        err(`Unknown command: ${subcommand}\n`);
        return 1;
    }
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    if (client) {
      await client.close().catch(() => undefined);
    } else if (transport) {
      await transport.close().catch(() => undefined);
    }
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  }
}

if (isMainModule()) {
  runMcpCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
