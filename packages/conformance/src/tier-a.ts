import { AssertionError } from "node:assert/strict";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import { writeTranscript, type FixtureResult, type TranscriptFrame } from "./run.js";

type Observation = void | { frames: readonly TranscriptFrame[]; mcpEndpoint?: string; zeroWire?: boolean };
function record(fixture: ExchangeFixture, mutant: string | undefined, obs: Observation) {
  if (mutant === undefined && obs) writeTranscript({ fixture: fixture.id, ...obs });
}

async function loadOptionalConformance(specifier: string): Promise<{ runExchange: (fixture: unknown, mutant?: string) => Promise<Observation> }> {
  return (await import(specifier)) as { runExchange: (fixture: unknown, mutant?: string) => Promise<Observation> };
}

const isObservationMismatch = (error: unknown): boolean =>
  error instanceof AssertionError ||
  (error instanceof Error && (error.name === "ObservationMismatch" || (error as { isObservationMismatch?: boolean }).isObservationMismatch === true));

/** Package-specific Tier A scripts; core wire scripts use the in-process adapter. */
export async function runTierAProvider(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const result = { id: fixture.id, ...(mutant !== undefined ? { mutant } : {}) };
  const area = fixture.id.split("/", 1)[0];
  let isMismatch: (error: unknown) => boolean = () => false;
  try {
    const optional: [string, string][] = [
      ["ext/cc/", "@mcp-client/ext-client-credentials/conformance"],
      ["ext/ema/", "@mcp-client/ext-enterprise-auth/conformance"],
      ["ext/tasks/", "@mcp-client/ext-tasks/conformance"],
      ["ext/skills/", "@mcp-client/ext-skills/conformance"],
      ["tel/", "@mcp-client/telemetry-otel/conformance"],
      ["ext/apps/", "@mcp-client/ext-apps/conformance"],
      ["ext/card/", "@mcp-client/ext-server-cards/conformance"],
      ["ext/events/webhook/", "@mcp-client/ext-events-webhook/conformance"],
      ["ext/events/", "@mcp-client/ext-events/conformance"],
    ];
    for (const [prefix, specifier] of optional) {
      if (fixture.id.startsWith(prefix)) {
        isMismatch = isObservationMismatch;
        const { runExchange } = await loadOptionalConformance(specifier);
        record(fixture, mutant, await runExchange(fixture, mutant));
        return { ...result, ok: true };
      }
    }
    switch (area) {
      case "auth":
      case "consent": {
        const { runExchange } = await import("@mcp-client/auth/conformance");
        isMismatch = (error) => error instanceof AssertionError;
        record(fixture, mutant, await runExchange(fixture, mutant));
        break;
      }
      case "mrtr":
      case "elic":
      case "sub":
      case "cache": {
        const { runExchange, MrtrObservationMismatch } = await import("@mcp-client/mrtr-cache/conformance");
        isMismatch = (error) => error instanceof MrtrObservationMismatch;
        record(fixture, mutant, await runExchange(fixture, mutant));
        break;
      }
      case "ops": {
        const { runExchange, OpsObservationMismatch } = await import("@mcp-client/ops/conformance");
        isMismatch = (error) => error instanceof OpsObservationMismatch;
        record(fixture, mutant, await runExchange(fixture, mutant));
        break;
      }
      default:
        return undefined;
    }
    return { ...result, ok: true };
  } catch (error) {
    return {
      ...result,
      ok: false,
      ...(isMismatch(error) ? { failure: "assertion" as const } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
