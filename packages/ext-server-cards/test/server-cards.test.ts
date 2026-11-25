import { describe, expect, it } from "vitest";
import { SafeFetch } from "@mcp/auth";
import type { DiscoverResult, FetchPort } from "@mcp/core";
import {
  CORE_PROTOCOL_VERSION,
  ServerCardCache,
  ServerCardError,
  canonicalServerCardUrl,
  createServerCardsExtension,
  discoverCard,
  discoverFromDomain,
  parseServerCard,
  reconcileWithDiscover,
} from "../src/index.js";

const validCard = (overrides: Record<string, unknown> = {}) => ({
  $schema: "https://modelcontextprotocol.io/schemas/server-card.json",
  name: "demo-server",
  version: "1.2.3",
  description: "Demo server",
  ...overrides,
});

describe("server cards unit", () => {
  it("real SafeFetch rejects private IPs", async () => {
    await expect(discoverCard("https://127.0.0.1/server-card", { fetch: new SafeFetch() })).rejects.toThrow();
    await expect(discoverCard("https://10.0.0.1/server-card")).rejects.toThrow(/fetch-address-blocked/u);
  });

  it("rejects http: outside loopback allowInsecureDev", async () => {
    await expect(discoverCard("http://example.com/server-card")).rejects.toBeInstanceOf(ServerCardError);
    await expect(discoverCard("http://127.0.0.1/server-card")).rejects.toBeInstanceOf(ServerCardError);

    const mockFetch: FetchPort = {
      async fetch(url) {
        expect(url).toBe("http://127.0.0.1/server-card");
        return new Response(JSON.stringify(validCard()), { status: 200 });
      },
    };
    const parsed = await discoverCard("http://127.0.0.1/server-card", {
      fetch: mockFetch,
      allowInsecureDev: true,
    });
    expect(parsed.card.name).toBe("demo-server");
  });

  it("canonical url helper", () => {
    expect(canonicalServerCardUrl("https://a.test/mcp/?x=1")).toBe("https://a.test/mcp/server-card");
  });

  it("validates required fields, drops primitives, filters remotes, and never infers capabilities", () => {
    expect(() => parseServerCard({ name: "x" }, "u")).toThrow(ServerCardError);
    const p = parseServerCard(
      validCard({
        tools: [{ name: "t" }],
        resources: [],
        prompts: [],
        remotes: [
          { type: "stdio", url: "stdio://local", supportedVersions: [CORE_PROTOCOL_VERSION] },
          { type: "streamable-http", url: "https://a.test/old", supportedVersions: ["2024-11-05"] },
          {
            type: "streamable-http",
            url: "https://a.test/mcp",
            supportedVersions: [CORE_PROTOCOL_VERSION],
            extensionsInfo: { "io.modelcontextprotocol/apps": {} },
          },
        ],
      }),
      "https://a.test/server-card",
    );
    expect("tools" in p.card).toBe(false);
    expect(p.ignoredFields).toEqual(["tools", "resources", "prompts"]);
    expect(p.inferredCapabilities).toEqual({});
    expect(p.connectionCandidates).toEqual([
      {
        url: "https://a.test/mcp",
        supportedVersions: [CORE_PROTOCOL_VERSION],
        extensionsInfo: { "io.modelcontextprotocol/apps": {} },
      },
    ]);
  });

  it("strips userinfo and auth/cookie headers and obeys cache-control + etag 304", async () => {
    let now = 1000;
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let step = 0;
    const mockFetch: FetchPort = {
      async fetch(url, init) {
        const headers: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => {
          headers[k] = v;
        });
        seen.push({ url, headers });
        step += 1;
        if (step === 1) {
          return new Response(JSON.stringify(validCard({ version: "1.0.0" })), {
            status: 200,
            headers: { "cache-control": "max-age=10", etag: '"v1"' },
          });
        }
        if (step === 2) {
          return new Response(null, {
            status: 304,
            headers: { "cache-control": "max-age=5" },
          });
        }
        return new Response(JSON.stringify(validCard({ version: "2.0.0" })), {
          status: 200,
          headers: { "cache-control": "no-store" },
        });
      },
    };
    const cache = new ServerCardCache({ now: () => now, setTimeout: () => () => undefined });

    const r1 = await discoverCard("https://user:secret@example.com/card#frag", {
      fetch: mockFetch,
      cache,
      headers: { Authorization: "Bearer tok", Cookie: "sid=1", "X-Trace": "ok" },
    });
    expect(r1.card.version).toBe("1.0.0");
    expect(seen[0]!.url).toBe("https://example.com/card");
    expect(seen[0]!.headers).toEqual({ accept: "application/json", "x-trace": "ok" });

    // Within max-age=10: served from cache with zero fetch.
    now = 5000;
    const rCached = await discoverCard("https://example.com/card", { fetch: mockFetch, cache });
    expect(rCached.card.version).toBe("1.0.0");
    expect(seen).toHaveLength(1);

    // Expired: sends If-None-Match and refreshes on 304.
    now = 12_000;
    const r304 = await discoverCard("https://example.com/card", { fetch: mockFetch, cache });
    expect(r304.card.version).toBe("1.0.0");
    expect(seen[1]!.headers["if-none-match"]).toBe('"v1"');

    // no-store evicts cache entry.
    now = 20_000;
    const r3 = await discoverCard("https://example.com/card", { fetch: mockFetch, cache });
    expect(r3.card.version).toBe("2.0.0");
    expect(cache.get("https://example.com/card")).toBeUndefined();
  });

  it("discovers inline and linked MCP cards from /.well-known/ai-catalog.json", async () => {
    const mockFetch: FetchPort = {
      async fetch(url) {
        if (url === "https://example.com/.well-known/ai-catalog.json") {
          return new Response(
            JSON.stringify({
              entries: [
                { type: "other", url: "/ignored.json" },
                { type: "mcp-server-card", data: validCard({ name: "inline-srv" }) },
                { type: "mcp", url: "/cards/linked.json" },
              ],
            }),
            { status: 200 },
          );
        }
        if (url === "https://example.com/cards/linked.json") {
          return new Response(JSON.stringify(validCard({ name: "linked-srv" })), { status: 200 });
        }
        return new Response("", { status: 404 });
      },
    };
    const cards = await discoverFromDomain("example.com", { fetch: mockFetch });
    expect(cards.map((c) => c.card.name)).toEqual(["inline-srv", "linked-srv"]);
  });

  it("reconcileWithDiscover prefers live discover and reports mismatches", () => {
    const parsed = parseServerCard(
      validCard({
        name: "card-name",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "https://a.test/mcp", supportedVersions: [CORE_PROTOCOL_VERSION] }],
      }),
      "https://a.test/server-card",
    );
    const live = {
      supportedVersions: ["2025-11-25"],
      serverInfo: { name: "live-name", version: "2.0.0" },
    } as unknown as DiscoverResult;
    const rec = reconcileWithDiscover(parsed, live);
    expect(rec.effective).toBe(live);
    expect(rec.mismatches).toEqual(["name", "version", "supportedVersions"]);
  });

  it("advertises no capability", () => expect(createServerCardsExtension().capabilities?.(true)).toEqual({}));

  it("importing has no side effects", async () => {
    const before = Object.keys(globalThis).sort();
    await import("../src/index.js");
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });
});
