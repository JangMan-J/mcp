import type { Outcome, RequestOptions } from "@mcp-client/core";
import { gate, isObj, mapMethodNotFound, mapOutcome, type CapabilitySource, type OpsClient } from "./common.js";
import { hasInvalidMedia, normalizeContentBlock, type ContentBlock } from "./content.js";
import { cursorParams, listAll, nextCursorOf, type ListAllOptions, type ListAllResult } from "./pagination.js";

export interface PromptsListResult {
  readonly prompts: Record<string, unknown>[];
  readonly nextCursor?: string;
  readonly ttlMs?: unknown;
  readonly cacheScope?: unknown;
}

export interface PromptMessage {
  readonly role: string;
  readonly content: ContentBlock;
  readonly raw: unknown;
}

export interface PromptGetResult {
  readonly raw: Record<string, unknown>;
  readonly description?: string;
  readonly messages: PromptMessage[];
}

export class PromptsApi {
  constructor(
    private readonly client: OpsClient,
    private readonly opts: { readonly capabilities?: CapabilitySource } = {},
  ) {}

  async list(opts?: RequestOptions & { readonly cursor?: string }): Promise<Outcome<PromptsListResult>> {
    const blocked = gate<PromptsListResult>(this.opts.capabilities, "prompts", "prompts/list");
    if (blocked) return blocked;
    const { cursor, ...ro } = opts ?? {};
    const o = await this.client.request<Record<string, unknown>>("prompts/list", cursorParams(cursor), { ...ro, idempotent: true });
    return mapOutcome(mapMethodNotFound(o, "prompts"), (v, meta) => {
      const next = nextCursorOf(v);
      if (!Array.isArray(v["prompts"]) || !next.ok) return { kind: "protocol-violation", detail: { reason: "bad-prompts-list" }, meta };
      return {
        kind: "ok",
        value: {
          prompts: v["prompts"] as Record<string, unknown>[],
          ...(next.cursor !== undefined ? { nextCursor: next.cursor } : {}),
          ...("ttlMs" in v ? { ttlMs: v["ttlMs"] } : {}),
          ...("cacheScope" in v ? { cacheScope: v["cacheScope"] } : {}),
        },
        meta,
      };
    });
  }

  listAll(opts?: RequestOptions & ListAllOptions): Promise<Outcome<ListAllResult<Record<string, unknown>>>> {
    const { maxPages, maxItems, restartOnInvalidCursor, ...ro } = opts ?? {};
    return listAll<Record<string, unknown>>(
      "prompts/list",
      async (cursor) =>
        mapOutcome(await this.list({ ...ro, ...(cursor !== undefined ? { cursor } : {}) }), (v, meta) => ({
          kind: "ok",
          value: { items: v.prompts, ...(v.nextCursor !== undefined ? { nextCursor: v.nextCursor } : {}) },
          meta,
        })),
      {
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(restartOnInvalidCursor !== undefined ? { restartOnInvalidCursor } : {}),
      },
    );
  }

  async get(name: string, args?: Record<string, string>, opts?: RequestOptions): Promise<Outcome<PromptGetResult>> {
    const blocked = gate<PromptGetResult>(this.opts.capabilities, "prompts", "prompts/get");
    if (blocked) return blocked;
    const o = await this.client.request<Record<string, unknown>>(
      "prompts/get",
      { name, ...(args !== undefined ? { arguments: args } : {}) },
      opts,
    );
    return mapOutcome(mapMethodNotFound(o, "prompts"), (v, meta) => {
      if (!Array.isArray(v["messages"])) return { kind: "protocol-violation", detail: { reason: "messages-not-array" }, meta };
      const messages: PromptMessage[] = [];
      for (const m of v["messages"]) {
        const content = normalizeContentBlock(isObj(m) ? m["content"] : undefined);
        if (hasInvalidMedia(content)) {
          return { kind: "protocol-violation", detail: { reason: "invalid-media", issues: content.issues }, meta };
        }
        messages.push({ role: isObj(m) && typeof m["role"] === "string" ? m["role"] : "", content, raw: m });
      }
      return {
        kind: "ok",
        value: { raw: v, ...(typeof v["description"] === "string" ? { description: v["description"] } : {}), messages },
        meta,
      };
    });
  }
}
