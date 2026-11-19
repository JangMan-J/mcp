import type { Outcome, RequestOptions } from "@mcp-client/core";
import {
  gate,
  isObj,
  local,
  mapMethodNotFound,
  mapOutcome,
  type CapabilitySource,
  type OpsClient,
} from "./common.js";
import { normalizeContent, type ContentBlock } from "./content.js";
import { listAll, cursorParams, nextCursorOf, type ListAllOptions, type ListAllResult } from "./pagination.js";
import { createBuiltinValidator, type SchemaIssue, type SchemaValidator } from "./schema.js";

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export type SchemaState = "valid" | "unsupported-dialect" | "invalid-schema";

export interface ToolEntry {
  readonly name: string;
  /** The tool exactly as received. */
  readonly tool: Record<string, unknown>;
  readonly nameWarnings: readonly string[];
  /** Annotations are untrusted unless ServerTrust says otherwise (OPS-TOOLS-6). Never used for retry. */
  readonly annotations?: { readonly value: unknown; readonly trust: "untrusted" | "trusted" };
  readonly inputValidation: SchemaState;
  readonly outputValidation?: SchemaState;
}

export interface ToolsListResult {
  readonly tools: ToolEntry[];
  readonly nextCursor?: string;
  readonly ttlMs?: unknown;
  readonly cacheScope?: unknown;
  readonly warnings: string[];
  readonly excluded: { readonly name: string | undefined; readonly reason: string; readonly detail?: string }[];
}

export interface CallContext {
  readonly name: string;
  readonly arguments: unknown;
  readonly opts: RequestOptions | undefined;
}

export interface ToolHooks {
  /** Return `false` or `{ veto: reason }` to prevent the send. Host policy (OPS-TOOLS-17). */
  beforeCall?(ctx: CallContext): void | boolean | { readonly veto: string } | Promise<void | boolean | { readonly veto: string }>;
  afterCall?(ctx: CallContext, outcome: Outcome<unknown>): void | Promise<void>;
}

export interface ToolsOptions {
  readonly capabilities?: CapabilitySource;
  readonly validator?: SchemaValidator;
  /** Host trust for annotations. Default: untrusted. */
  readonly serverTrusted?: boolean;
  readonly hooks?: ToolHooks;
}

export interface ToolCallOptions extends RequestOptions {
  /** Default true (OPS-TOOLS-12). */
  readonly validateInput?: boolean;
  /** Call a tool whose schema has an unsupported dialect (OPS-SCHEMA-2). Default false. */
  readonly allowUnvalidated?: boolean;
  /** Turn an outputSchema mismatch into protocol-violation (OPS-TOOLS-11). Default false. */
  readonly strictOutput?: boolean;
}

export interface OutputValidation {
  readonly status: "valid" | "invalid" | "skipped" | "unsupported-dialect" | "invalid-schema" | "no-schema";
  readonly errors?: readonly SchemaIssue[];
}

export interface ToolCallResult {
  /** Raw complete result, untouched (OPS-TOOLS-15). */
  readonly raw: Record<string, unknown>;
  readonly content: ContentBlock[];
  /** Any JSON value; do not assume an object (OPS-SCHEMA-7). */
  readonly structuredContent?: unknown;
  readonly validation: OutputValidation;
}

interface Compiled {
  input?: ReturnType<SchemaValidator["compile"]>;
  output?: ReturnType<SchemaValidator["compile"]>;
}

export class ToolsApi {
  private readonly compiled = new Map<string, Compiled>();
  private readonly validator: SchemaValidator;

  constructor(
    private readonly client: OpsClient,
    private readonly opts: ToolsOptions = {},
  ) {
    this.validator = opts.validator ?? createBuiltinValidator();
  }

  async list(opts?: RequestOptions & { readonly cursor?: string }): Promise<Outcome<ToolsListResult>> {
    const blocked = gate<ToolsListResult>(this.opts.capabilities, "tools", "tools/list");
    if (blocked) return blocked;
    const { cursor, ...ro } = opts ?? {};
    const o = await this.client.request<Record<string, unknown>>("tools/list", cursorParams(cursor), { ...ro, idempotent: true });
    return mapOutcome(mapMethodNotFound(o, "tools"), (v, meta) => {
      const page = this.parsePage(v);
      if (!page) return { kind: "protocol-violation", detail: { reason: "tools-not-array" }, meta };
      return { kind: "ok", value: page, meta };
    });
  }

  async listAll(opts?: RequestOptions & ListAllOptions): Promise<Outcome<ListAllResult<ToolEntry> & { warnings: string[]; excluded: ToolsListResult["excluded"] }>> {
    const warnings: string[] = [];
    const excluded: ToolsListResult["excluded"][number][] = [];
    const { maxPages, maxItems, restartOnInvalidCursor, ...ro } = opts ?? {};
    const o = await listAll<ToolEntry>(
      "tools/list",
      async (cursor) => {
        const r = await this.list({ ...ro, ...(cursor !== undefined ? { cursor } : {}) });
        return mapOutcome(r, (v, meta) => {
          warnings.push(...v.warnings);
          excluded.push(...v.excluded);
          return { kind: "ok", value: { items: v.tools, ...(v.nextCursor !== undefined ? { nextCursor: v.nextCursor } : {}) }, meta };
        });
      },
      {
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(restartOnInvalidCursor !== undefined ? { restartOnInvalidCursor } : {}),
      },
    );
    return mapOutcome(o, (v, meta) => ({ kind: "ok", value: { ...v, warnings, excluded }, meta }));
  }

  private parsePage(v: Record<string, unknown>): ToolsListResult | undefined {
    if (!Array.isArray(v["tools"])) return undefined;
    const next = nextCursorOf(v);
    if (!next.ok) return undefined;
    const tools: ToolEntry[] = [];
    const warnings: string[] = [];
    const excluded: ToolsListResult["excluded"][number][] = [];
    for (const raw of v["tools"]) {
      const name = isObj(raw) && typeof raw["name"] === "string" ? raw["name"] : undefined;
      if (!isObj(raw) || name === undefined) {
        warnings.push("excluded tool without a string name");
        excluded.push({ name, reason: "malformed-tool" });
        continue;
      }
      const inSchema = raw["inputSchema"];
      if (!isObj(inSchema)) {
        warnings.push(`excluded tool '${name}': inputSchema must be a JSON Schema object`);
        excluded.push({ name, reason: "invalid-inputSchema" });
        continue;
      }
      const input = this.validator.compile(inSchema);
      if (!input.ok && input.reason === "invalid-schema") {
        warnings.push(`excluded tool '${name}': ${input.message}`);
        excluded.push({ name, reason: "invalid-schema", detail: input.message });
        continue;
      }
      const c: Compiled = { input };
      let outputValidation: SchemaState | undefined;
      if (raw["outputSchema"] !== undefined) {
        const out = this.validator.compile(raw["outputSchema"]);
        c.output = out;
        outputValidation = out.ok ? "valid" : out.reason;
        if (!out.ok) warnings.push(`tool '${name}' outputSchema: ${out.message}`);
      }
      this.compiled.set(name, c);
      const nameWarnings: string[] = [];
      if (!NAME_RE.test(name)) nameWarnings.push("name-not-1-128-of-[A-Za-z0-9_.-]");
      if (tools.some((t) => t.name === name)) nameWarnings.push("duplicate-name");
      tools.push({
        name,
        tool: raw,
        nameWarnings,
        ...(raw["annotations"] !== undefined
          ? { annotations: { value: raw["annotations"], trust: this.opts.serverTrusted === true ? ("trusted" as const) : ("untrusted" as const) } }
          : {}),
        inputValidation: input.ok ? "valid" : input.reason,
        ...(outputValidation ? { outputValidation } : {}),
      });
    }
    return {
      tools,
      ...(next.cursor !== undefined ? { nextCursor: next.cursor } : {}),
      ...("ttlMs" in v ? { ttlMs: v["ttlMs"] } : {}),
      ...("cacheScope" in v ? { cacheScope: v["cacheScope"] } : {}),
      warnings,
      excluded,
    };
  }

  async call(name: string, args?: unknown, opts?: ToolCallOptions): Promise<Outcome<ToolCallResult>> {
    const { validateInput = true, allowUnvalidated = false, strictOutput = false, ...ro } = opts ?? {};
    const blocked = gate<ToolCallResult>(this.opts.capabilities, "tools", "tools/call");
    if (blocked) return blocked;

    const comp = this.compiled.get(name);
    if (validateInput && comp?.input) {
      if (!comp.input.ok) {
        if (!allowUnvalidated) {
          return local("invalid-schema", "tools/call", { reason: comp.input.reason, dialect: comp.input.dialect, message: comp.input.message });
        }
      } else {
        const r = comp.input.validate(args ?? {});
        if (!r.valid) return local("invalid-arguments", "tools/call", { errors: r.errors });
      }
    }

    const ctx: CallContext = { name, arguments: args, opts };
    const verdict = await this.opts.hooks?.beforeCall?.(ctx);
    if (verdict === false || (isObj(verdict) && "veto" in verdict)) {
      return local("local-error", "tools/call", { reason: "vetoed", veto: isObj(verdict) ? verdict["veto"] : undefined });
    }

    const params: Record<string, unknown> = { name, ...(args !== undefined ? { arguments: args } : {}) };
    // Annotations never make a call idempotent (OPS-TOOLS-6); idempotent is the caller's choice only.
    const o = await this.client.request<Record<string, unknown>>("tools/call", params, ro);
    const mapped = mapOutcome(mapMethodNotFound(o, "tools"), (v, meta) => {
      const content = normalizeContent(v["content"]);
      let validation: OutputValidation = { status: "no-schema" };
      if ("structuredContent" in v && comp?.output) {
        if (!comp.output.ok) validation = { status: comp.output.reason };
        else {
          const r = comp.output.validate(v["structuredContent"]);
          validation = r.valid ? { status: "valid" } : { status: "invalid", errors: r.errors };
        }
      } else if (comp?.output && !("structuredContent" in v)) {
        validation = { status: "skipped" };
      }
      if (strictOutput && validation.status === "invalid") {
        return { kind: "protocol-violation", detail: { reason: "output-schema-mismatch", errors: validation.errors }, meta };
      }
      return {
        kind: "ok",
        value: {
          raw: v,
          content,
          ...("structuredContent" in v ? { structuredContent: v["structuredContent"] as unknown } : {}),
          validation,
        },
        meta,
      };
    });
    await this.opts.hooks?.afterCall?.(ctx, mapped as Outcome<unknown>);
    return mapped;
  }
}
