import { SafeFetch } from "@mcp/auth";
import type { Clock, DiscoverResult, Extension, ExtensionCapabilities, FetchPort } from "@mcp/core";

/** Advisory MCP Server Cards (SEP-2127). Import has no side effects (EXT-REG-1). */
export const SERVER_CARDS_EXTENSION_ID = "io.modelcontextprotocol/server-card";
export const CORE_PROTOCOL_VERSION = "2026-07-28";
const PRIMITIVES = ["tools", "resources", "prompts"] as const;

export interface ServerCardRemote {
  readonly type: string;
  readonly url: string;
  readonly supportedVersions?: readonly string[];
  readonly extensionsInfo?: unknown;
  readonly [k: string]: unknown;
}
export interface ServerCard {
  readonly $schema: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly title?: string;
  readonly icons?: unknown;
  readonly repository?: unknown;
  readonly websiteUrl?: string;
  readonly remotes?: readonly ServerCardRemote[];
  readonly _meta?: Record<string, unknown>;
}
export interface ConnectionCandidate { readonly url: string; readonly supportedVersions: readonly string[]; readonly extensionsInfo?: unknown }
export interface ParsedServerCard {
  readonly url: string;
  readonly card: ServerCard;
  readonly connectionCandidates: readonly ConnectionCandidate[];
  /** Always empty: card metadata never becomes negotiated capability (EXT-card-9). */
  readonly inferredCapabilities: Record<string, never>;
  readonly ignoredFields: readonly string[];
}

export class ServerCardError extends Error {
  constructor(readonly code: string) { super(`server card: ${code}`); this.name = "ServerCardError"; }
}
const fail = (code: string): never => { throw new ServerCardError(code); };

export interface ServerCardCacheEntry { readonly parsed: ParsedServerCard; readonly etag?: string; readonly freshUntil: number }
export class ServerCardCache {
  readonly #map = new Map<string, ServerCardCacheEntry>();
  constructor(readonly clock: Clock = { now: () => Date.now(), setTimeout: () => () => undefined }) {}
  get(url: string): ServerCardCacheEntry | undefined { return this.#map.get(url); }
  set(url: string, e: ServerCardCacheEntry): void { this.#map.set(url, e); }
  delete(url: string): void { this.#map.delete(url); }
}

export interface DiscoverCardOptions {
  readonly fetch?: FetchPort;
  readonly allowInsecureDev?: boolean;
  readonly headers?: Record<string, string>;
  readonly cache?: ServerCardCache;
}

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function safeUrl(input: string, o: DiscoverCardOptions): URL {
  let u: URL;
  try { u = new URL(input); } catch { return fail("invalid-url"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && o.allowInsecureDev === true && loopback)) fail("insecure-url");
  u.username = "";
  u.password = "";
  u.hash = "";
  return u;
}

function cleanHeaders(o: DiscoverCardOptions): Record<string, string> {
  const out: Record<string, string> = { accept: "application/json" };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    const lk = k.toLowerCase();
    if (lk === "authorization" || lk === "cookie") continue;
    out[lk] = v;
  }
  return out;
}

const port = (o: DiscoverCardOptions): FetchPort => o.fetch ?? new SafeFetch({ allowInsecureDev: o.allowInsecureDev === true });

/** `<streamable-http base>/server-card` helper. */
export function canonicalServerCardUrl(streamableHttpUrl: string): string {
  const u = new URL(streamableHttpUrl);
  u.hash = ""; u.search = "";
  u.pathname = u.pathname.replace(/\/+$/u, "") + "/server-card";
  return u.href;
}

/** Validate untrusted JSON against the pinned ServerCard shape. */
export function parseServerCard(raw: unknown, url: string): ParsedServerCard {
  const r = rec(raw) ?? fail("card-not-object");
  for (const k of ["$schema", "name", "version", "description"]) if (typeof r[k] !== "string") fail(`card-field-${k}`);
  const ignoredFields = PRIMITIVES.filter((p) => p in r);
  const card: Record<string, unknown> = { $schema: r["$schema"], name: r["name"], version: r["version"], description: r["description"] };
  if (typeof r["title"] === "string") card["title"] = r["title"];
  if (typeof r["websiteUrl"] === "string") card["websiteUrl"] = r["websiteUrl"];
  if (r["icons"] !== undefined) card["icons"] = r["icons"];
  if (r["repository"] !== undefined) card["repository"] = r["repository"];
  if (rec(r["_meta"])) card["_meta"] = r["_meta"];
  const remotes: ServerCardRemote[] = [];
  if (r["remotes"] !== undefined) {
    if (!Array.isArray(r["remotes"])) fail("card-field-remotes");
    for (const x of r["remotes"] as unknown[]) {
      const m = rec(x);
      if (!m || typeof m["type"] !== "string" || typeof m["url"] !== "string") continue;
      const sv = m["supportedVersions"] ?? m["supportedProtocolVersions"];
      const versions = Array.isArray(sv) ? sv.filter((v): v is string => typeof v === "string") : [];
      remotes.push({ ...m, type: m["type"], url: m["url"], supportedVersions: versions });
    }
    card["remotes"] = remotes;
  }
  const connectionCandidates = remotes
    .filter((m) => m.type === "streamable-http" && (m.supportedVersions ?? []).includes(CORE_PROTOCOL_VERSION))
    .map((m) => ({ url: m.url, supportedVersions: m.supportedVersions ?? [], ...(m.extensionsInfo !== undefined ? { extensionsInfo: m.extensionsInfo } : {}) }));
  return { url, card: card as unknown as ServerCard, connectionCandidates, inferredCapabilities: {}, ignoredFields };
}

function maxAge(cc: string | null): { store: boolean; ms: number } {
  const v = (cc ?? "").toLowerCase();
  if (/(^|,)\s*no-store\b/u.test(v)) return { store: false, ms: 0 };
  const m = /max-age\s*=\s*(\d+)/u.exec(v);
  return { store: true, ms: m ? Number(m[1]) * 1000 : 0 };
}

async function getJson(url: string, o: DiscoverCardOptions, extra: Record<string, string> = {}): Promise<Response> {
  return port(o).fetch(url, { method: "GET", headers: { ...cleanHeaders(o), ...extra }, redirect: "error" });
}

/** Fetch an explicit card URL. Never opens an MCP session or calls server/discover (EXT-card-1, EXT-card-8). */
export async function discoverCard(url: string, opts: DiscoverCardOptions = {}): Promise<ParsedServerCard> {
  const u = safeUrl(url, opts).href;
  const cache = opts.cache;
  const now = cache?.clock.now() ?? 0;
  const hit = cache?.get(u);
  if (hit && hit.freshUntil > now) return hit.parsed;
  const cond: Record<string, string> = hit?.etag ? { "if-none-match": hit.etag } : {};
  const res = await getJson(u, opts, cond);
  const policy = maxAge(res.headers.get("cache-control"));
  if (res.status === 304 && hit) {
    cache?.set(u, { ...hit, freshUntil: now + policy.ms });
    return hit.parsed;
  }
  if (res.status !== 200) fail(`http-${res.status}`);
  let body: unknown;
  try { body = JSON.parse(await res.text()); } catch { return fail("invalid-json"); }
  const parsed = parseServerCard(body, u);
  if (cache) {
    if (policy.store) {
      const etag = res.headers.get("etag") ?? undefined;
      cache.set(u, { parsed, freshUntil: now + policy.ms, ...(etag ? { etag } : {}) });
    } else cache.delete(u);
  }
  return parsed;
}

/** Fetch `/.well-known/ai-catalog.json` and resolve MCP server card entries (EXT-card-2). */
export async function discoverFromDomain(domainOrOrigin: string, opts: DiscoverCardOptions = {}): Promise<ParsedServerCard[]> {
  const origin = safeUrl(/^[a-z][a-z0-9+.-]*:\/\//iu.test(domainOrOrigin) ? domainOrOrigin : `https://${domainOrOrigin}`, opts).origin;
  const catalogUrl = `${origin}/.well-known/ai-catalog.json`;
  const res = await getJson(catalogUrl, opts);
  if (res.status !== 200) fail(`http-${res.status}`);
  let doc: unknown;
  try { doc = JSON.parse(await res.text()); } catch { return fail("invalid-json"); }
  const d = rec(doc) ?? fail("catalog-not-object");
  const list = [d["entries"], d["servers"], d["items"]].find(Array.isArray) as unknown[] | undefined ?? [];
  const out: ParsedServerCard[] = [];
  for (const x of list) {
    const e = rec(x);
    if (!e) continue;
    const kind = String(e["type"] ?? e["kind"] ?? e["mediaType"] ?? "");
    if (kind && !/mcp|server-card/iu.test(kind)) continue;
    const data = rec(e["data"]);
    if (data) out.push(parseServerCard(data, catalogUrl));
    else if (typeof e["url"] === "string") out.push(await discoverCard(new URL(e["url"], origin).href, opts));
  }
  return out;
}

export interface Reconciliation { readonly effective: DiscoverResult; readonly mismatches: string[] }
/** Live server/discover always wins over the advisory card (EXT-card-4). */
export function reconcileWithDiscover(card: ServerCard | ParsedServerCard, liveDiscover: DiscoverResult): Reconciliation {
  const c: ServerCard = "card" in card ? card.card : card;
  const live = liveDiscover as DiscoverResult & { serverInfo?: { name?: string; version?: string } };
  const mismatches: string[] = [];
  if (live.serverInfo?.name !== undefined && live.serverInfo.name !== c.name) mismatches.push("name");
  if (live.serverInfo?.version !== undefined && live.serverInfo.version !== c.version) mismatches.push("version");
  const cardVersions = [...new Set((c.remotes ?? []).flatMap((r) => r.supportedVersions ?? []))].sort();
  const liveVersions = [...(live.supportedVersions ?? [])].sort();
  if (cardVersions.length > 0 && JSON.stringify(cardVersions) !== JSON.stringify(liveVersions)) mismatches.push("supportedVersions");
  return { effective: liveDiscover, mismatches };
}

export interface ServerCardsExtension extends Extension {
  discoverCard(url: string, opts?: DiscoverCardOptions): Promise<ParsedServerCard>;
  discoverFromDomain(domainOrOrigin: string, opts?: DiscoverCardOptions): Promise<ParsedServerCard[]>;
}
/** Advertises no client capability (EXT-card-8). */
export function createServerCardsExtension(defaults: DiscoverCardOptions = {}): ServerCardsExtension {
  return {
    id: SERVER_CARDS_EXTENSION_ID,
    capabilities: (): ExtensionCapabilities => ({}),
    discoverCard: (url, o) => discoverCard(url, { ...defaults, ...o }),
    discoverFromDomain: (d, o) => discoverFromDomain(d, { ...defaults, ...o }),
  };
}

export const DEFAULT_SERVER_CARD_SCHEMA = "https://modelcontextprotocol.io/schemas/server-card.json";

export interface ServerCardInput {
  readonly $schema?: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly title?: string;
  readonly icons?: unknown;
  readonly repository?: unknown;
  readonly websiteUrl?: string;
  readonly remotes?: readonly ServerCardRemote[];
  readonly _meta?: Record<string, unknown>;
}

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ServerCardError(`card-field-${field}`);
  return value;
}

/**
 * Build an advisory Server Card for a server you operate.
 *
 * Cards are discovery metadata only: tools/resources/prompts primitives are
 * rejected so a card cannot become an inferred capability document. Live
 * server/discover remains authoritative.
 */
export function buildServerCard(input: ServerCardInput): ServerCard {
  for (const primitive of ["tools", "resources", "prompts"]) {
    if (primitive in input) throw new ServerCardError("card-primitives-not-allowed");
  }
  const card: Record<string, unknown> = {
    $schema: input.$schema ?? DEFAULT_SERVER_CARD_SCHEMA,
    name: required(input.name, "name"),
    version: required(input.version, "version"),
    description: required(input.description, "description"),
  };
  if (input.title !== undefined) card["title"] = input.title;
  if (input.websiteUrl !== undefined) card["websiteUrl"] = input.websiteUrl;
  if (input.icons !== undefined) card["icons"] = input.icons;
  if (input.repository !== undefined) card["repository"] = input.repository;
  if (input.remotes !== undefined) {
    card["remotes"] = input.remotes.map((remote) => {
      const type = required(remote.type, "remote-type");
      const url = required(remote.url, "remote-url");
      const supportedVersions = remote.supportedVersions ?? [];
      if (!Array.isArray(supportedVersions) || supportedVersions.some((v) => typeof v !== "string")) {
        throw new ServerCardError("card-field-supportedVersions");
      }
      return { ...remote, type, url, supportedVersions: [...supportedVersions] };
    });
  }
  if (input._meta !== undefined) card["_meta"] = input._meta;
  return card as unknown as ServerCard;
}

/** Wrap cards in the /.well-known/ai-catalog.json document shape. */
export function buildAiCatalog(cards: readonly ServerCard[]): { entries: Array<{ type: "mcp-server-card"; data: ServerCard }> } {
  return { entries: cards.map((card) => ({ type: "mcp-server-card", data: card })) };
}
