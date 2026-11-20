#!/usr/bin/env node

export interface CutArgs {
  readonly url: string;
  readonly scenario: string;
  readonly context: Record<string, unknown>;
}

type RunnerFn = (url: string, scenario: string, context: Record<string, unknown>) => Promise<unknown>;

function parseContext(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid MCP_CONFORMANCE_CONTEXT JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP_CONFORMANCE_CONTEXT: expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function parseCutArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CutArgs {
  let scenario = env["MCP_CONFORMANCE_SCENARIO"];
  let contextRaw = env["MCP_CONFORMANCE_CONTEXT"];
  let url = env["MCP_CONFORMANCE_URL"];
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--scenario" && i + 1 < argv.length) {
      scenario = argv[++i];
    } else if (arg.startsWith("--scenario=")) {
      scenario = arg.slice("--scenario=".length);
    } else if (arg === "--context" && i + 1 < argv.length) {
      contextRaw = argv[++i];
    } else if (arg.startsWith("--context=")) {
      contextRaw = arg.slice("--context=".length);
    } else if (arg === "--url" && i + 1 < argv.length) {
      url = argv[++i];
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }

  if (!url && positional.length > 0) {
    url = positional[positional.length - 1];
  }

  if (!scenario || scenario.trim() === "") {
    throw new Error("Missing scenario: set MCP_CONFORMANCE_SCENARIO or pass --scenario <name>");
  }
  if (!url || url.trim() === "") {
    throw new Error("Missing server URL: pass <url> argument, --url <url>, or set MCP_CONFORMANCE_URL");
  }

  const context = parseContext(contextRaw);
  return { url, scenario, context };
}

export function isAuthScenario(scenario: string): boolean {
  return /^auth(?:[\/:-]|$)/.test(scenario);
}

export async function dispatchCut(args: CutArgs): Promise<unknown> {
  if (isAuthScenario(args.scenario)) {
    const spec = "./auth.js";
    const mod = (await import(spec)) as { runAuth?: RunnerFn };
    if (typeof mod.runAuth !== "function") {
      throw new Error("./auth.js does not export runAuth(url, scenario, context)");
    }
    return mod.runAuth(args.url, args.scenario, args.context);
  }

  const spec = "./operations.js";
  const mod = (await import(spec)) as { runOperations?: RunnerFn };
  if (typeof mod.runOperations !== "function") {
    throw new Error("./operations.js does not export runOperations(url, scenario, context)");
  }
  return mod.runOperations(args.url, args.scenario, args.context);
}

async function main(): Promise<number> {
  const parsed = parseCutArgs(process.argv.slice(2), process.env);
  const result = await dispatchCut(parsed);
  if (typeof result === "number") return result;
  if (result && typeof result === "object" && "ok" in result && (result as { ok?: unknown }).ok === false) {
    return 1;
  }
  return 0;
}

const isEntry =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("/main.js") || process.argv[1].endsWith("\\main.js") || process.argv[1].endsWith("/main.ts"));

if (isEntry) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
