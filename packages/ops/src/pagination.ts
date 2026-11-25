import type { Outcome, RequestOptions } from "@mcp/core";
import { local, mapOutcome, isObj } from "./common.js";

export const DEFAULT_MAX_PAGES = 1000;
export const DEFAULT_MAX_ITEMS = 100_000;

export interface ListAllOptions {
  readonly maxPages?: number;
  readonly maxItems?: number;
  /** PAGE-6: restart once from the first page after -32602, only when true. */
  readonly restartOnInvalidCursor?: boolean;
}

export interface ListAllResult<T> {
  readonly items: T[];
  readonly pages: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}

export type PageFetcher<T> = (cursor: string | undefined) => PromiseLike<Outcome<Page<T>>>;

/** Read the opaque cursor for a request. An empty string is a real cursor (PAGE-2). */
export function cursorParams(cursor: string | undefined): Record<string, unknown> {
  return cursor === undefined ? {} : { cursor };
}

export function nextCursorOf(result: unknown): { ok: true; cursor: string | undefined } | { ok: false } {
  if (!isObj(result)) return { ok: false };
  const c = result["nextCursor"];
  if (c === undefined || c === null) return { ok: true, cursor: undefined };
  return typeof c === "string" ? { ok: true, cursor: c } : { ok: false };
}

/**
 * Follow nextCursor until absent (PAGE-1). Cursors are echoed unchanged and never parsed
 * (PAGE-3). Page size is not assumed (PAGE-4). Loop guard per PAGE-5.
 */
export async function listAll<T>(
  method: string,
  fetchPage: PageFetcher<T>,
  opts: ListAllOptions = {},
): Promise<Outcome<ListAllResult<T>>> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  let restarted = false;
  for (;;) {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    let restart = false;
    for (;;) {
      const o = await fetchPage(cursor);
      if (o.kind !== "ok") {
        if (
          o.kind === "jsonrpc-error" &&
          o.code === -32602 &&
          cursor !== undefined &&
          opts.restartOnInvalidCursor === true &&
          !restarted
        ) {
          restarted = true;
          restart = true;
          break;
        }
        return mapOutcome(o, () => local<ListAllResult<T>>("local-error", method, "unreachable"));
      }
      pages += 1;
      items.push(...o.value.items);
      if (items.length > maxItems) {
        return local("limit-exceeded", method, { limit: "maxItems", max: maxItems, observed: items.length });
      }
      const next = o.value.nextCursor;
      if (next === undefined) return { kind: "ok", value: { items, pages }, meta: o.meta };
      if (seen.has(next)) {
        return local("protocol-violation", method, { reason: "cursor-loop", pages });
      }
      if (pages >= maxPages) {
        return local("limit-exceeded", method, { limit: "maxPages", max: maxPages, observed: pages });
      }
      seen.add(next);
      cursor = next;
    }
    if (!restart) break;
  }
  return local("local-error", method, "unreachable");
}

export type ListCallOptions = RequestOptions;
