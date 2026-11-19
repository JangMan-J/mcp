import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { McpClient, type Transport } from "@mcp-client/core";
import { describe, expect, it } from "vitest";
import {
  createOtelTelemetry,
  instrumentClient,
  RecordingTracer,
} from "../src/index.js";
import {
  ObservationMismatch,
  runExchange,
  supportsMutant,
} from "../src/conformance.js";

const fixturesDir = new URL("../../fixtures/exchanges/tel/", import.meta.url);
const requirementsPath = new URL("../../conformance/requirements.json", import.meta.url);
const coreSrcDir = new URL("../../core/src/", import.meta.url);

interface FixtureFile {
  id: string;
  requirements: string[];
  mutants: string[];
}

function loadFixtures(): FixtureFile[] {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".exchange.json")).sort();
  return files.map((f) => JSON.parse(readFileSync(new URL(f, fixturesDir), "utf8")) as FixtureFile);
}

describe("@mcp-client/telemetry-otel conformance fixtures", () => {
  const fixtures = loadFixtures();

  it("loads all 4 grouped fixtures and verifies requirement IDs are resolved", () => {
    expect(fixtures).toHaveLength(4);
    const reqDoc = JSON.parse(readFileSync(requirementsPath, "utf8")) as {
      rows?: Array<{ id: string; disposition?: string; openQuestion?: string | null }>;
    };
    const reqMap = new Map((reqDoc.rows ?? []).map((r) => [r.id, r]));
    for (const fx of fixtures) {
      expect(fx.requirements).not.toContain("TEL-SPAN-1");
      for (const reqId of fx.requirements) {
        const row = reqMap.get(reqId);
        expect(row).toBeDefined();
        expect(row?.disposition).not.toBe("unresolved");
        expect(row?.openQuestion).toBeNull();
      }
    }
  });

  it.each(fixtures.map((f) => [f.id, f]))("passes baseline fixture %s", async (_id, fx) => {
    await expect(runExchange(fx)).resolves.toBeUndefined();
  });

  it("fails every mutant with ObservationMismatch", async () => {
    for (const fx of fixtures) {
      expect(fx.mutants.length).toBeGreaterThan(0);
      for (const mutant of fx.mutants) {
        expect(supportsMutant(mutant)).toBe(true);
        let caught: unknown;
        try {
          await runExchange(fx, mutant);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ObservationMismatch);
      }
    }
  });

  it("throws plain Error for unknown mutant", async () => {
    await expect(runExchange(fixtures[0], "nonexistent-mutant")).rejects.toThrow(/Unknown mutant/);
    try {
      await runExchange(fixtures[0], "nonexistent-mutant");
    } catch (err) {
      expect(err).not.toBeInstanceOf(ObservationMismatch);
    }
  });
});

describe("@mcp-client/telemetry-otel invariants", () => {
  it("TEL-ADAPT-1: packages/core/src has zero @opentelemetry imports", () => {
    const checkDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) checkDir(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          expect(text).not.toMatch(/@opentelemetry/);
        }
      }
    };
    checkDir(coreSrcDir.pathname);
  });

  it("TEL-CTX-2: drops baggage > 64 members and tracestate > 512 chars with diagnostics", () => {
    const diagnostics: string[] = [];
    const telemetry = createOtelTelemetry({
      tracer: new RecordingTracer(),
      contextSource: {
        activeSpanContext: () => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1,
          traceState: "a=" + "z".repeat(520),
        }),
        activeBaggage: () => Array.from({ length: 65 }, (_, i) => `k${i}=v${i}`).join(","),
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const ctx = telemetry.activeContext();
    expect(ctx?.traceparent).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(ctx?.tracestate).toBeUndefined();
    expect(ctx?.baggage).toBeUndefined();
    expect(diagnostics).toEqual(["tracestate-truncated-or-dropped", "baggage-dropped"]);
  });

  it("TEL-PRIV-1: defaults captureContent to false and redacts secrets even when true", () => {
    const tracer = new RecordingTracer();
    const defaultPort = createOtelTelemetry({ tracer });
    expect(defaultPort.captureContent).toBe(false);

    const optInPort = createOtelTelemetry({ tracer, captureContent: true });
    const span = optInPort.startClientSpan("mcp.client tools/call", {
      "mcp.tool.arguments": '{"q":"hello"}',
      authorization: "Bearer secret-jwt",
      "url.full": "https://u:p@example.com/?client_secret=cs&assertion=as",
    });
    span.end({ ok: true });
    const attrs = tracer.spans[0]!.attributes;
    expect(attrs["mcp.tool.arguments"]).toBe('{"q":"hello"}');
    expect(attrs["authorization"]).toBeUndefined();
    expect(String(attrs["url.full"])).not.toContain(":p@");
    expect(String(attrs["url.full"])).not.toContain("=cs");
    expect(String(attrs["url.full"])).not.toContain("=as");
  });

  it("instrumentClient records a single client span per request", async () => {
    const tracer = new RecordingTracer();
    const telemetry = createOtelTelemetry({ tracer });
    const transport: Transport = {
      binding: "stdio",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg) {
        return {
          notifications: { async *[Symbol.asyncIterator]() {} },
          done: Promise.resolve({ kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: {} } }),
        };
      },
    };
    const client = instrumentClient(
      new McpClient({ transport, server: { key: "s1" } }),
      telemetry,
      { protocolVersion: "2025-11-25" },
    );
    const outcome = await client.request("ping", {});
    expect(outcome.kind).toBe("ok");
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]!.attributes["mcp.method.name"]).toBe("ping");
    expect(tracer.spans[0]!.attributes["mcp.protocol.version"]).toBe("2025-11-25");
    expect(tracer.spans[0]!.ended).toBe(true);
  });
});
