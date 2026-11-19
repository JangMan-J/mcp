import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createCoreAdapter } from "../src/adapter.js";
import { runConformance, type RunOptions } from "../src/run.js";

const exchangesDir = fileURLToPath(new URL("../../fixtures/exchanges/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

for (const [area, subdir] of [["ext:cc", "ext/cc"], ["ext:ema", "ext/ema"], ["ext:tasks", "ext/tasks"], ["ext:skills", "ext/skills"], ["tel", "tel"]] as const) {
  if (existsSync(join(exchangesDir, subdir))) {
    it(`runs Tier A ${area} exchanges and detects their mutants by default`, async () => {
      for (const mutate of [false, true]) {
        const summary = await runConformance({ exchangesDir, tier: "A", area, mutate });
        expect(summary.results.filter((r) => !r.ok)).toEqual([]);
        expect(summary.passed).toBeGreaterThan(0);
      }
    });
  }
}

it.each(["auth", "consent", "mrtr", "elic", "sub", "cache", "ops", "wire", "ver", "prog", "smoke"])(
  "runs Tier A %s exchanges and detects their mutants by default",
  async (area) => {
    const options = { exchangesDir, tier: "A", area } as const;
    for (const mutate of [false, true]) {
      const summary = await runConformance({ ...options, mutate });
      expect(summary.results.filter((r) => !r.ok)).toEqual([]);
      expect(summary.passed).toBeGreaterThan(0);
    }
  },
);

const coreFixture = {
  id: "wire/custom",
  tier: "A",
  script: [{ do: "call", as: "call", method: "tools/list", abortBeforeSend: true }],
  expect: { wire: { totalRequests: 0 } },
  mutants: ["not-a-mutant"],
};

async function runSynthetic(fixture: object, options: Partial<RunOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tier-a-"));
  try {
    writeFileSync(join(dir, "test.exchange.json"), JSON.stringify(fixture));
    return await runConformance({ ...options, exchangesDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it("does not fall back to the core adapter for an unhandled fixture", async () => {
  const summary = await runSynthetic({ ...coreFixture, id: "other/custom" });
  expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Unhandled") });
});

it("does not count a missing script as a kill", async () => {
  for (const area of ["auth", "cache", "ops", "wire"]) {
    const summary = await runSynthetic({ ...coreFixture, id: `${area}/empty`, script: [], expect: {} }, { mutate: true });
    expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline") });
  }
});

it("does not count unsupported mutants or a failing baseline as killed", async () => {
  const unsupported = await runSynthetic(coreFixture, { mutate: true });
  expect(unsupported.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("mutant") });
  const baseline = await runSynthetic({ ...coreFixture, expect: { wire: { totalRequests: 9 } } }, { mutate: true });
  expect(baseline.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("Baseline") });
});

it("does not count a survivor as killed", async () => {
  const summary = await runSynthetic({ ...coreFixture, mutants: ["omit-protocol-version"] }, { mutate: true });
  expect(summary.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("VACUOUS") });
});

it("filters comma-separated colon areas ext:cc,ext:ema", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tier-a-area-"));
  try {
    for (const id of ["ext/cc/one", "ext/ema/two", "ext/tasks/three", "tel/four"]) {
      const f = { ...coreFixture, id };
      const file = join(dir, `${id.replace(/\//g, "-")}.exchange.json`);
      writeFileSync(file, JSON.stringify(f));
    }
    const summary = await runConformance({ exchangesDir: dir, tier: "A", area: "ext:cc,ext:ema", adapter: createCoreAdapter() });
    expect(summary.results.map((r) => r.id).sort()).toEqual(["ext/cc/one", "ext/ema/two"]);
    expect(summary.ok).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("counts optional ObservationMismatch as a mutant kill", async () => {
  const realPkg = join(repoRoot, "packages/ext-client-credentials");
  if (existsSync(realPkg)) {
    // Real package present: its fixtures are covered by the optional-area loop above.
    const summary = await runConformance({ exchangesDir, tier: "A", area: "ext:cc", mutate: true });
    expect(summary.results.filter((r) => !r.ok)).toEqual([]);
    expect(summary.passed).toBeGreaterThan(0);
    return;
  }
  const fakeDir = join(repoRoot, "node_modules/@mcp-client/ext-client-credentials");
  expect(existsSync(fakeDir)).toBe(false);
  mkdirSync(fakeDir, { recursive: true });
  try {
    writeFileSync(join(fakeDir, "package.json"), JSON.stringify({ name: "@mcp-client/ext-client-credentials", version: "0.1.0", type: "module", exports: { "./conformance": "./conformance.js" } }));
    writeFileSync(join(fakeDir, "conformance.js"), `export async function runExchange(fixture, mutant) { if (mutant) { const e = new Error("mismatch"); e.name = "ObservationMismatch"; throw e; } }`);
    const dir = mkdtempSync(join(tmpdir(), "tier-a-opt-"));
    try {
      writeFileSync(join(dir, "x.exchange.json"), JSON.stringify({ ...coreFixture, id: "ext/cc/synthetic", mutants: ["mismatch-mutant"] }));
      const summary = await runConformance({ exchangesDir: dir, mutate: true });
      expect(summary.ok).toBe(true);
      expect(summary.results[0]).toMatchObject({ ok: true, mutant: "mismatch-mutant" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally { rmSync(fakeDir, { recursive: true, force: true }); }
});

it("uses an explicit adapter even for a provider-owned area, and reports adapter setup errors", async () => {
  const fixture = { ...coreFixture, id: "ops/custom" };
  for (const tier of ["A", "B"]) {
    expect((await runSynthetic({ ...fixture, tier }, { adapter: createCoreAdapter() })).ok).toBe(true);
  }
  const core = createCoreAdapter();
  const failedSetup = await runSynthetic(fixture, {
    mutate: true,
    adapter: { create(setup) {
      if (setup.mutant) throw new Error("broken setup");
      return core.create(setup);
    } },
  });
  expect(failedSetup.results[0]).toMatchObject({ ok: false, error: expect.stringContaining("broken setup") });
});

it("exports observed baseline transcripts to MCP_CONFORMANCE_TRANSCRIPTS without inventing frames", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const out = mkdtempSync(join(tmpdir(), "tier-a-transcripts-"));
  const prev = process.env["MCP_CONFORMANCE_TRANSCRIPTS"];
  process.env["MCP_CONFORMANCE_TRANSCRIPTS"] = out;
  try {
    const fixture = {
      ...coreFixture,
      id: "wire/observed",
      script: [
        { do: "call", as: "c1", method: "tools/list" },
        { server: "result", for: "c1", result: { tools: [], resultType: "complete" } },
        { server: "result", id: 4242, result: { never: "delivered" } },
      ],
      expect: { wire: { totalRequests: 1 } },
      mutants: ["omit-protocol-version"],
    };
    const summary = await runSynthetic(fixture, { mutate: true });
    expect(summary.results.some((r) => r.error?.startsWith("Baseline"))).toBe(false);
    const files = readdirSync(out);
    // Mutant runs never write; only the baseline transcript exists.
    expect(files).toEqual(["wire__observed.transcript.json"]);
    const t = JSON.parse(readFileSync(join(out, files[0]!), "utf8"));
    expect(t.fixture).toBe("wire/observed");
    expect(t.frames.map((f: { direction: string }) => f.direction)).toEqual(["client", "server"]);
    const [client, server] = t.frames;
    // The client frame is what the client serialized, including fields the fixture never scripted.
    expect(client.message).toMatchObject({ jsonrpc: "2.0", method: "tools/list" });
    expect(JSON.stringify(client.message)).toContain("protocolVersion");
    expect(server.message).toEqual({ jsonrpc: "2.0", id: client.message.id, result: { tools: [], resultType: "complete" } });
    // A delivery to a non-pending id is not observed, so it is not in the transcript.
    expect(JSON.stringify(t.frames)).not.toContain("never");
    expect(t.incomplete.length).toBeGreaterThan(0);

    rmSync(out, { recursive: true, force: true });
    await runSynthetic({ ...coreFixture, id: "ops/provider" });
    const provider = JSON.parse(readFileSync(join(out, "ops__provider.transcript.json"), "utf8"));
    expect(provider).toMatchObject({ fixture: "ops/provider", frames: [] });
    expect(provider.incomplete[0]).toContain("not observed");
  } finally {
    if (prev === undefined) delete process.env["MCP_CONFORMANCE_TRANSCRIPTS"];
    else process.env["MCP_CONFORMANCE_TRANSCRIPTS"] = prev;
    rmSync(out, { recursive: true, force: true });
  }
});
