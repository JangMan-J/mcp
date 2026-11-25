import type { Outcome, RequestOptions } from "@mcp/core";
import { gate, isObj, mapMethodNotFound, mapOutcome, type CapabilitySource, type OpsClient } from "./common.js";
import { checkAnnotations, isRfc3986Uri, normalizeResourceContents, type ResourceEntry } from "./content.js";
import { cursorParams, listAll, nextCursorOf, type ListAllOptions, type ListAllResult } from "./pagination.js";
import { expandUriTemplate, type TemplateValue } from "./uri-template.js";

export interface FlaggedItem {
  readonly raw: Record<string, unknown>;
  readonly issues: readonly string[];
}

export interface ResourcesListResult {
  readonly items: FlaggedItem[];
  readonly nextCursor?: string;
  readonly ttlMs?: unknown;
  readonly cacheScope?: unknown;
}

export interface ResourceReadResult {
  readonly raw: Record<string, unknown>;
  readonly contents: ResourceEntry[];
  /** OPS-RES-4: true for any empty contents. Not-found is never inferred. */
  readonly empty: boolean;
}

type ListKind = "resources" | "resourceTemplates";

function flag(raw: unknown, uriKey: "uri" | "uriTemplate"): FlaggedItem | undefined {
  if (!isObj(raw)) return undefined;
  const issues: string[] = [];
  const u = raw[uriKey];
  if (typeof u !== "string") issues.push(`missing-${uriKey}`);
  else if (uriKey === "uri" && !isRfc3986Uri(u)) issues.push("invalid-uri");
  checkAnnotations(raw["annotations"], issues);
  return { raw, issues };
}

export class ResourcesApi {
  constructor(
    private readonly client: OpsClient,
    private readonly opts: { readonly capabilities?: CapabilitySource } = {},
  ) {}

  private async page(
    method: "resources/list" | "resources/templates/list",
    key: ListKind,
    opts?: RequestOptions & { readonly cursor?: string },
  ): Promise<Outcome<ResourcesListResult>> {
    const blocked = gate<ResourcesListResult>(this.opts.capabilities, "resources", method);
    if (blocked) return blocked;
    const { cursor, ...ro } = opts ?? {};
    const o = await this.client.request<Record<string, unknown>>(method, cursorParams(cursor), { ...ro, idempotent: true });
    return mapOutcome(mapMethodNotFound(o, "resources"), (v, meta) => {
      const next = nextCursorOf(v);
      const arr = v[key];
      if (!Array.isArray(arr) || !next.ok) return { kind: "protocol-violation", detail: { reason: `bad-${method}` }, meta };
      const items: FlaggedItem[] = [];
      for (const x of arr) {
        const f = flag(x, key === "resources" ? "uri" : "uriTemplate");
        if (f) items.push(f);
      }
      return {
        kind: "ok",
        value: {
          items,
          ...(next.cursor !== undefined ? { nextCursor: next.cursor } : {}),
          ...("ttlMs" in v ? { ttlMs: v["ttlMs"] } : {}),
          ...("cacheScope" in v ? { cacheScope: v["cacheScope"] } : {}),
        },
        meta,
      };
    });
  }

  list(opts?: RequestOptions & { readonly cursor?: string }): Promise<Outcome<ResourcesListResult>> {
    return this.page("resources/list", "resources", opts);
  }

  listTemplates(opts?: RequestOptions & { readonly cursor?: string }): Promise<Outcome<ResourcesListResult>> {
    return this.page("resources/templates/list", "resourceTemplates", opts);
  }

  private all(
    method: "resources/list" | "resources/templates/list",
    opts?: RequestOptions & ListAllOptions,
  ): Promise<Outcome<ListAllResult<FlaggedItem>>> {
    const { maxPages, maxItems, restartOnInvalidCursor, ...ro } = opts ?? {};
    return listAll<FlaggedItem>(
      method,
      async (cursor) =>
        mapOutcome(
          await (method === "resources/list" ? this.list : this.listTemplates).call(this, { ...ro, ...(cursor !== undefined ? { cursor } : {}) }),
          (v, meta) => ({
            kind: "ok",
            value: { items: v.items, ...(v.nextCursor !== undefined ? { nextCursor: v.nextCursor } : {}) },
            meta,
          }),
        ),
      {
        ...(maxPages !== undefined ? { maxPages } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(restartOnInvalidCursor !== undefined ? { restartOnInvalidCursor } : {}),
      },
    );
  }

  listAll(opts?: RequestOptions & ListAllOptions): Promise<Outcome<ListAllResult<FlaggedItem>>> {
    return this.all("resources/list", opts);
  }

  listAllTemplates(opts?: RequestOptions & ListAllOptions): Promise<Outcome<ListAllResult<FlaggedItem>>> {
    return this.all("resources/templates/list", opts);
  }

  /** RFC 6570 level 1-4 expansion, local only. */
  expandTemplate(template: string, vars: Readonly<Record<string, TemplateValue>>): string {
    return expandUriTemplate(template, vars);
  }

  /** resources/read. Never fetches the URI itself (OPS-RES-5). */
  async read(uri: string, opts?: RequestOptions): Promise<Outcome<ResourceReadResult>> {
    const blocked = gate<ResourceReadResult>(this.opts.capabilities, "resources", "resources/read");
    if (blocked) return blocked;
    const o = await this.client.request<Record<string, unknown>>("resources/read", { uri }, { ...opts, idempotent: true });
    const m = mapMethodNotFound(o, "resources");
    if (m.kind === "jsonrpc-error" && (m.code === -32602 || m.code === -32002)) {
      return { ...m, refined: "resource-not-found" };
    }
    return mapOutcome(m, (v, meta) => {
      if (!Array.isArray(v["contents"])) return { kind: "protocol-violation", detail: { reason: "contents-not-array" }, meta };
      const contents: ResourceEntry[] = [];
      for (const c of v["contents"]) {
        const e = normalizeResourceContents(c);
        if (!e) return { kind: "protocol-violation", detail: { reason: "contents-entry-needs-text-xor-blob" }, meta };
        contents.push(e);
      }
      return { kind: "ok", value: { raw: v, contents, empty: contents.length === 0 }, meta };
    });
  }
}
