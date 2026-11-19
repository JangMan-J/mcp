import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SafeFetch } from "@mcp-client/auth";
import { canonicalServerCardUrl, createServerCardsExtension, discoverCard, parseServerCard, ServerCardError } from "../src/index.js";
import { ObservationMismatch, runExchange, supportsMutant } from "../src/conformance.js";

const dir = new URL("../../fixtures/exchanges/ext/card/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".exchange.json"));
const reqs = JSON.parse(readFileSync(new URL("../../conformance/requirements.json", import.meta.url), "utf8")) as { rows: { id: string; disposition: string }[] };

describe("ext/card exchanges", () => {
  it("has fixtures", () => expect(files.length).toBeGreaterThanOrEqual(2));
  for (const f of files) {
    it(f, async () => {
      const fx = JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { id: string; requirements: string[]; mutants: string[] };
      expect(fx.id.startsWith("ext/card/")).toBe(true);
      for (const r of fx.requirements) expect(reqs.rows.find((x) => x.id === r)?.disposition).not.toBe("unresolved");
      await runExchange(fx);
      for (const m of fx.mutants) {
        expect(supportsMutant(m)).toBe(true);
        await expect(runExchange(fx, m), m).rejects.toBeInstanceOf(ObservationMismatch);
      }
    });
  }
  it("malformed fixtures are not mismatches", async () => {
    await expect(runExchange({ tier: "A", script: [{ bogus: 1 }] })).rejects.not.toBeInstanceOf(ObservationMismatch);
    await expect(runExchange({ tier: "A", script: [] }, "nope")).rejects.not.toBeInstanceOf(ObservationMismatch);
  });
});

describe("server cards unit", () => {
  it("real SafeFetch rejects private IPs (EXT-card-6)", async () => {
    await expect(discoverCard("https://127.0.0.1/server-card", { fetch: new SafeFetch() })).rejects.toThrow();
    await expect(discoverCard("https://10.0.0.1/server-card")).rejects.toThrow(/fetch-address-blocked/u);
  });
  it("rejects http:", async () => {
    await expect(discoverCard("http://example.com/server-card")).rejects.toBeInstanceOf(ServerCardError);
  });
  it("canonical url helper", () => {
    expect(canonicalServerCardUrl("https://a.test/mcp/?x=1")).toBe("https://a.test/mcp/server-card");
  });
  it("validates required fields and drops primitives", () => {
    expect(() => parseServerCard({ name: "x" }, "u")).toThrow(ServerCardError);
    const p = parseServerCard({ $schema: "s", name: "n", version: "1", description: "d", tools: [] }, "u");
    expect("tools" in p.card).toBe(false);
    expect(p.ignoredFields).toEqual(["tools"]);
    expect(p.inferredCapabilities).toEqual({});
  });
  it("advertises no capability", () => expect(createServerCardsExtension().capabilities(true)).toEqual({}));
  it("records the EXT-card-10 stage conflict as unresolved", () => {
    const pin = readFileSync(new URL("../PIN.md", import.meta.url), "utf8");
    expect(pin).toMatch(/EXT-card-10/u);
    expect(pin).toMatch(/Beta/u);
    expect(pin).toMatch(/Protocol Revision: draft/u);
    expect(pin).toMatch(/unresolved/u);
    expect(pin).toMatch(/28db12c9b4a379489d46e49bf1bd4a991f05c9b7/u);
    expect(reqs.rows.find((r) => r.id === "EXT-card-10")?.disposition).toBe("unresolved");
  });
  it("importing has no side effects (EXT-REG-1)", async () => {
    const before = Object.keys(globalThis).sort();
    await import("../src/index.js");
    expect(Object.keys(globalThis).sort()).toEqual(before);
  });
});
