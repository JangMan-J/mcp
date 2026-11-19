import { AssertionError } from "node:assert/strict";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";

/** Package-specific Tier A scripts; core wire scripts use the in-process adapter. */
export async function runTierAProvider(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const result = { id: fixture.id, ...(mutant !== undefined ? { mutant } : {}) };
  const area = fixture.id.split("/", 1)[0];
  let isMismatch: (error: unknown) => boolean = () => false;
  try {
    switch (area) {
      case "auth":
      case "consent": {
        const { runExchange } = await import("@mcp-client/auth/conformance");
        isMismatch = (error) => error instanceof AssertionError;
        await runExchange(fixture, mutant);
        break;
      }
      case "mrtr":
      case "elic":
      case "sub":
      case "cache": {
        const { runExchange, MrtrObservationMismatch } = await import("@mcp-client/mrtr-cache/conformance");
        isMismatch = (error) => error instanceof MrtrObservationMismatch;
        await runExchange(fixture, mutant);
        break;
      }
      case "ops": {
        const { runExchange, OpsObservationMismatch } = await import("@mcp-client/ops/conformance");
        isMismatch = (error) => error instanceof OpsObservationMismatch;
        await runExchange(fixture, mutant);
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
