import { isDeepStrictEqual } from "node:util";
import type { DiscoverResult, FetchPort } from "@mcp-client/core";
import { createServerCardsExtension, reconcileWithDiscover, ServerCardCache, ServerCardError } from "./index.js";
import type { DiscoverCardOptions, ParsedServerCard } from "./index.js";

/** Thrown only when an observation differs from the fixture's expectation. */
export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const MUTANTS = new Set([
  "expose-primitives", "all-transports", "infer-capabilities", "advertise-capability", "forward-credentials",
  "allow-http", "connect-mcp", "skip-inline", "ignore-cache", "no-etag", "card-wins",
]);
export const supportsMutant = (name: string): boolean => MUTANTS.has(name);

type Json = Record<string, unknown>;
const bad = (msg: string): never => { throw new Error(`malformed fixture: ${msg}`); };
const mismatch = (msg: string): never => { throw new ObservationMismatch(msg); };
const eq = (actual: unknown, expected: unknown, label: string) => {
  if (!isDeepStrictEqual(actual, expected)) mismatch(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const rec = (v: unknown, what: string): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : bad(what));
const str = (v: unknown, what: string): string => (typeof v === "string" ? v : bad(what));

interface Served { status?: number; headers?: Record<string, string>; body?: unknown }

export async function runExchange(fixture: unknown, mutant?: string): Promise<void> {
  if (mutant !== undefined && !supportsMutant(mutant)) bad(`unknown mutant ${mutant}`);
  const fx = rec(fixture, "fixture");
  if (fx["tier"] !== "A") bad("tier");
  const script = Array.isArray(fx["script"]) ? (fx["script"] as unknown[]) : bad("script");
  const serve = rec(fx["serve"] ?? {}, "serve");
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  const hits = new Map<string, number>();
  let now = 1_700_000_000_000;
  const fetchPort: FetchPort = {
    async fetch(input, init) {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
      requests.push({ method: init.method ?? "GET", url: input, headers });
      const seq = serve[input];
      const list = (Array.isArray(seq) ? seq : seq === undefined ? [] : [seq]) as Served[];
      const i = hits.get(input) ?? 0;
      hits.set(input, i + 1);
      const s = list[Math.min(i, list.length - 1)];
      if (!s) return new Response("", { status: 404 });
      const status = s.status ?? 200;
      return new Response(status === 304 ? null : JSON.stringify(s.body ?? {}), { status, headers: s.headers ?? {} });
    },
  };
  const cache = new ServerCardCache({ now: () => now, setTimeout: () => () => undefined });
  const ext = createServerCardsExtension();
  const opts = (step: Json): DiscoverCardOptions => ({
    fetch: fetchPort, cache,
    ...(step["headers"] ? { headers: rec(step["headers"], "headers") as Record<string, string> } : {}),
    ...(mutant ? { testMutant: mutant } : {}),
  });
  let last: ParsedServerCard | undefined;
  let lastList: ParsedServerCard[] = [];
  let lastError: string | undefined;
  let lastReconcile: unknown;

  for (const raw of script) {
    const step = rec(raw, "step");
    if ("do" in step) {
      lastError = undefined;
      try {
        switch (step["do"]) {
          case "card":
            last = await ext.discoverCard(str(step["url"], "url"), opts(step));
            if (mutant === "connect-mcp") await fetchPort.fetch(last.connectionCandidates[0]?.url ?? str(step["url"], "url"), { method: "POST", body: "{\"method\":\"server/discover\"}" });
            break;
          case "domain":
            lastList = await ext.discoverFromDomain(str(step["origin"], "origin"), opts(step));
            last = lastList[0];
            break;
          case "advance":
            now += typeof step["ms"] === "number" ? step["ms"] : bad("ms");
            break;
          case "reconcile": {
            const live = rec(step["live"], "live") as unknown as DiscoverResult;
            const r = reconcileWithDiscover(last ?? bad("no card"), live);
            lastReconcile = mutant === "card-wins" ? { ...r, effective: { ...live, supportedVersions: (last?.card.remotes ?? []).flatMap((x) => x.supportedVersions ?? []) } } : r;
            break;
          }
          default: bad(`do ${String(step["do"])}`);
        }
      } catch (e) {
        if (e instanceof ServerCardError) lastError = e.code;
        else if (e instanceof Error && e.name === "AuthError") lastError = (e as Error & { code?: string }).code ?? e.message;
        else throw e;
      }
      continue;
    }
    switch (step["expect"]) {
      case "card": eq(last?.card, step["value"], "card"); break;
      case "candidates": eq(last?.connectionCandidates.map((c) => c.url), step["values"], "candidates"); break;
      case "inferred-capabilities": eq(last?.inferredCapabilities, step["value"], "inferredCapabilities"); break;
      case "capabilities": eq(mutant === "advertise-capability" ? { [ext.id]: {} } : ext.capabilities(true), step["value"], "capabilities"); break;
      case "names": eq(lastList.map((c) => c.card.name), step["values"], "names"); break;
      case "error": eq(lastError ?? null, step["value"], "error"); break;
      case "fetches": eq(requests.map((r) => `${r.method} ${r.url}`), step["values"], "fetches"); break;
      case "no-credentials":
        for (const r of requests) {
          if ("authorization" in r.headers || "cookie" in r.headers || /\/\/[^/]*@/u.test(r.url)) mismatch(`credentials sent to ${r.url}`);
        }
        break;
      case "last-header": {
        const r = requests.at(-1) ?? mismatch("no request");
        eq(r.headers[str(step["name"], "name")], step["value"], `header ${String(step["name"])}`);
        break;
      }
      case "reconcile": eq(lastReconcile, step["value"], "reconcile"); break;
      default: bad(`expect ${String(step["expect"])}`);
    }
  }
}
