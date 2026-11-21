import { McpClient, type ClientRequest, type Outcome, type RequestOptions } from "@mcp-client/core";
import { HttpTransport, validateXmcpHeaderSchema } from "@mcp-client/transport-http";
import { createOps, type OpsClient, type ToolEntry } from "@mcp-client/ops";
import { StatefulClient, elicitationExtension, type ElicitationPort } from "@mcp-client/mrtr-cache";

export const OPERATION_SCENARIOS = [
  "tools_call",
  "request-metadata",
  "sep-2322-client-request-state",
  "http-standard-headers",
  "http-custom-headers",
  "http-invalid-tool-headers",
  "json-schema-ref-no-deref",
] as const;

const VERSION = "2026-07-28";
type Ctx = Record<string, unknown>;
const isRecord = (v: unknown): v is Ctx => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Smallest value satisfying a JSON Schema fragment, derived at runtime from
 * the server's own tools/list / elicitation schema (never hardcoded per tool).
 */
function sample(schema: unknown): unknown {
  if (!isRecord(schema)) return "test";
  if ("default" in schema) return schema["default"];
  if ("const" in schema) return schema["const"];
  const choices = schema["enum"];
  if (Array.isArray(choices) && choices.length > 0) return choices[0];
  const type = Array.isArray(schema["type"]) ? schema["type"][0] : schema["type"];
  switch (type) {
    case "number":
    case "integer":
      return typeof schema["minimum"] === "number" ? Math.max(1, schema["minimum"]) : 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const props = isRecord(schema["properties"]) ? schema["properties"] : {};
      const required = Array.isArray(schema["required"]) ? (schema["required"] as string[]) : [];
      return Object.fromEntries(required.map((k) => [k, sample(props[k])]));
    }
    default:
      return "test";
  }
}

/** Headless form port: accepts with schema-derived content. */
const formPort: ElicitationPort = {
  async form(request) {
    return { action: "accept", content: sample(request.schema) as Record<string, unknown> };
  },
};

function describe(o: Outcome<unknown>): string {
  switch (o.kind) {
    case "jsonrpc-error":
      return `jsonrpc-error(${o.code}): ${o.message}`;
    case "transport-failure":
      return `transport-failure(${o.failure.kind}): ${o.failure.message}`;
    default:
      return "detail" in o ? `${o.kind}: ${JSON.stringify(o.detail)}` : o.kind;
  }
}

function value<T>(o: Outcome<T>, scenario: string): T {
  if (o.kind === "ok") return o.value;
  throw new Error(`${scenario}: ${describe(o as Outcome<unknown>)}`);
}

/**
 * Runs one non-auth scenario against `url` over stateless HTTP.
 *
 * Layering (no library behaviour is reimplemented here):
 *   createOps (@mcp-client/ops)            tool discovery, schema validation, call mapping
 *     -> StatefulClient (@mcp-client/mrtr-cache)  result cache + MRTR requestState/elicitation rounds
 *       -> McpClient (@mcp-client/core)    request manager, outcome mapping
 *         -> HttpTransport                 wire headers; learns `x-mcp-header` annotations from
 *                                          tools/list responses and excludes tools whose
 *                                          annotations are invalid (HTTP-PARAM-1/2)
 *
 * Tool name and request `_meta` are NOT required context fields: the tool is
 * discovered from the server's tools/list (first entry, or `context.name`
 * when it names a discovered tool), and `_meta` is only forwarded when the
 * harness supplies `context.meta`. `context.arguments`, when present, is
 * passed to the discovered tool unchanged.
 *
 * Resolves with the observed result; rejects on any non-ok outcome.
 * `http-invalid-tool-headers` resolves only on the expected local rejection
 * (invalid-annotation tool excluded during discovery, no call sent); a
 * transport failure, a tool that survives discovery with an invalid
 * annotation, or the absence of any excluded tool all reject.
 *
 * Known contract/library gaps, reported rather than worked around:
 * - SEP-2322 rounds that request form/url elicitation need a host
 *   elicitation port; StatefulClient is constructed without one, so such a
 *   round surfaces as a protocol-violation outcome and this runner rejects.
 *   Pure requestState echo rounds (MRTR-C-4/5/6) need no port.
 * - There is no documented runner context field for the tool name or the
 *   request metadata, so neither can be targeted beyond discovery/first-tool
 *   selection above.
 */
export async function runOperations(url: string, scenario: string, context: Record<string, unknown>): Promise<unknown> {
  if (!(OPERATION_SCENARIOS as readonly string[]).includes(scenario)) throw new Error(`unknown scenario: ${scenario}`);

  const transport = new HttpTransport({ url, protocolVersion: VERSION });
  const mcp = new McpClient({
    transport,
    server: { key: url },
    supportedVersions: [VERSION],
    // clientInfo is a SHOULD in _meta; the runner warns (and exits 1) without it.
    clientInfo: { name: "mcp-client-conformance-cut", version: "0.1.0" },
    extensions: [elicitationExtension({ serverLabel: url, port: formPort })],
  });
  const stateful = new StatefulClient({
    request: (method, params, opts) => mcp.request(method, params, opts),
    serverRef: url,
    serverLabel: url,
    port: formPort,
  });
  // OpsClient's contract is the PromiseLike<ClientRequest> slice of a client;
  // StatefulClient returns a plain Promise<Outcome>. The ops layer only ever
  // awaits it, so this adapter changes no behaviour.
  const opsClient: OpsClient = {
    request<T>(method: string, params: Record<string, unknown> = {}, opts?: RequestOptions): ClientRequest<T> {
      return stateful.request(method, params, opts) as unknown as ClientRequest<T>;
    },
  };

  try {
    // Capability source for the ops gate, discovered through the library.
    // A failed discover is not fatal: with no known capabilities the ops
    // gate stays open and a -32601 maps to capability-absent instead.
    let capabilities: Ctx | undefined;
    const discovered = await stateful.request("server/discover", {});
    if (discovered.kind === "ok" && isRecord(discovered.value) && isRecord(discovered.value["capabilities"])) {
      capabilities = discovered.value["capabilities"];
    }
    // request-metadata's peer answers tools/* while declaring no capabilities,
    // so its (empty) declaration must not gate the calls.
    const ops = createOps(opsClient, capabilities && scenario !== "request-metadata" ? { capabilities } : {});

    const listTools = async (): Promise<readonly ToolEntry[]> => value(await ops.tools.listAll(), scenario).items;

    const pickTool = (tools: readonly ToolEntry[]): ToolEntry => {
      const wanted = typeof context["name"] === "string" && context["name"] !== "" ? context["name"] : undefined;
      if (wanted !== undefined) {
        const found = tools.find((t) => t.name === wanted);
        if (!found) throw new Error(`${scenario}: context.name '${wanted}' was not among the discovered tools`);
        return found;
      }
      const first = tools[0];
      if (!first) throw new Error(`${scenario}: server discovered no tools`);
      return first;
    };

    // Arguments: context.arguments, else a runner-supplied context.toolCalls
    // entry for this tool, else a sample built from the tool's inputSchema.
    // Runner-supplied arguments are sent verbatim (they may deliberately
    // break the schema, e.g. a null for an annotated boolean); sampled ones
    // stay validated.
    const argsFor = (tool: ToolEntry): { args: unknown; verbatim: boolean } => {
      if ("arguments" in context) return { args: context["arguments"], verbatim: true };
      const calls = Array.isArray(context["toolCalls"]) ? context["toolCalls"] : [];
      const planned = calls.find((c) => isRecord(c) && c["name"] === tool.name);
      if (isRecord(planned) && "arguments" in planned) return { args: planned["arguments"], verbatim: true };
      return { args: sample(tool.tool["inputSchema"]), verbatim: false };
    };

    const callOne = async (tool: ToolEntry, extra: RequestOptions = {}): Promise<unknown> => {
      const { args, verbatim } = argsFor(tool);
      return value(await ops.tools.call(tool.name, args, verbatim ? { ...extra, validateInput: false } : extra), scenario).raw;
    };

    const callTool = async (tools: readonly ToolEntry[], extra: RequestOptions = {}): Promise<unknown> =>
      callOne(pickTool(tools), extra);

    switch (scenario) {
      case "tools_call":
      case "http-standard-headers":
        // Discovery first: the transport caches each tool's x-mcp-header
        // annotations from the list response, the ops layer compiles the
        // schemas it later validates the call against.
        return await callTool(await listTools());
      case "request-metadata": {
        const meta = isRecord(context["meta"]) ? context["meta"] : undefined;
        const tools = await listTools();
        // The peer may list no tools; the listing request itself carries the metadata.
        return tools.length === 0 ? { scenario, listedTools: [] } : await callTool(tools, meta ? { meta } : {});
      }
      case "sep-2322-client-request-state":
        // StatefulClient's MRTR session echoes requestState verbatim on a
        // fresh request id and only adds inputResponses when the server
        // asked for input (MRTR-C-4/5/6).
        // The peer offers one tool per MRTR behaviour (echo state, no state,
        // unrelated, no resultType); the tool descriptions say each must be
        // exercised, and "unrelated" must run between rounds of another
        // call, so all discovered tools are called concurrently.
        return await Promise.all((await listTools()).map((t) => callOne(t, { mrtr: "auto" })));
      case "http-custom-headers": {
        // Call every tool the runner planned (context.toolCalls), in order.
        const tools = await listTools();
        const calls = Array.isArray(context["toolCalls"]) ? context["toolCalls"] : [];
        const results: unknown[] = [];
        for (const c of calls) {
          const entry = isRecord(c) ? tools.find((t) => t.name === c["name"]) : undefined;
          if (entry) results.push(await callOne(entry));
        }
        return results.length > 0 ? results : await callTool(tools);
      }
      case "http-invalid-tool-headers": {
        // Rejects here on transport failure or any other non-ok list outcome.
        const tools = await listTools();
        // An invalid annotation that survived discovery would be an accepted
        // invalid tool: the transport failed to exclude it.
        for (const t of tools) {
          const check = validateXmcpHeaderSchema(t.tool["inputSchema"]);
          if (!check.valid) {
            throw new Error(
              `${scenario}: tool '${t.name}' was accepted despite invalid x-mcp-header annotations: ${check.violations.join("; ")}`,
            );
          }
        }
        const rejected = transport
          .diagnosticsSnapshot()
          .filter((d) => d.kind === "violation" && d.message.includes("x-mcp-header"))
          .map((d) => d.message);
        if (rejected.length === 0) {
          throw new Error(
            `${scenario}: no tool was excluded for invalid x-mcp-header annotations; ` +
              "the expected local rejection did not occur (server offered no invalid tool, or exclusion is broken)",
          );
        }
        // Expected local rejection confirmed. No tools/call is sent for an
        // excluded tool; the tools that survived discovery are still valid
        // and must stay usable, so call each of them.
        for (const t of tools) await callOne(t);
        return { scenario, rejected, listedTools: tools.map((t) => t.name) };
      }
      case "json-schema-ref-no-deref":
        // ToolEntry.tool is the definition exactly as received: a $ref in
        // the inputSchema is returned unresolved. The ops validator never
        // fetches network references (no loadSchema), so listing is the
        // whole behaviour; excluded entries are reported, not hidden.
        return value(await ops.tools.listAll(), scenario);
      default:
        throw new Error(`unknown scenario: ${scenario}`);
    }
  } finally {
    await mcp.close();
  }
}
