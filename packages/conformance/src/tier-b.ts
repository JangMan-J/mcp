import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";
import { ObservationMismatch, runBinding } from "./tier-b-binding.js";

const actions = new Set(["two-listeners-demux", "two-listeners-demux-http", "stdio-restart-resend", "graceful-close", "graceful-close-stdio", "http-abrupt-reconnect-invalidates-cache", "client-cancel-http", "client-cancel-stdio"]);

export async function runTierBFixture(fixture: ExchangeFixture, mutant?: string): Promise<(FixtureResult & { mutationKilled?: boolean }) | undefined> {
  const action = (fixture.script[0] as { do?: string } | undefined)?.do;
  if (fixture.tier !== "B" || !fixture.id.startsWith("sub/") || !action || !actions.has(action)) return undefined;
  const result = { id: fixture.id, ...(mutant ? { mutant } : {}) };
  try {
    await runBinding(fixture, mutant);
    return { ...result, ok: true };
  } catch (error) {
    return { ...result, ok: false, ...(mutant && error instanceof ObservationMismatch ? { mutationKilled: true } : {}), error: error instanceof Error ? error.message : String(error) };
  }
}
