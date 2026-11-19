import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";
import { ObservationMismatch, runBinding } from "./tier-b-binding.js";
import { runTierBHttpHeadersFixture } from "./tier-b-http-headers.js";
import { runTierBHttpPostFixture } from "./tier-b-http-post.js";
import { runTierBHttpRedirectFixture } from "./tier-b-http-redirect.js";
import { runTierBHttpSseFixture } from "./tier-b-http-sse.js";
import { runTierBHttpStreamFixture } from "./tier-b-http-stream.js";
import { runTierBStdioLifecycleFixture } from "./tier-b-stdio-lifecycle.js";
import { runTierBStdioFixture } from "./tier-b-stdio.js";

const actions = new Set(["two-listeners-demux", "two-listeners-demux-http", "stdio-restart-resend", "graceful-close", "graceful-close-stdio", "http-abrupt-reconnect-invalidates-cache", "client-cancel-http", "client-cancel-stdio"]);

export async function runTierBFixture(fixture: ExchangeFixture, mutant?: string): Promise<(FixtureResult & { mutationKilled?: boolean }) | undefined> {
  const action = (fixture.script[0] as { do?: string } | undefined)?.do;
  if (fixture.tier !== "B" || !fixture.id.startsWith("sub/") || !action || !actions.has(action)) return undefined;
  const result = { id: fixture.id, ...(mutant ? { mutant } : {}) };
  try {
    await runBinding(fixture, mutant);
    return { ...result, ok: true };
  } catch (error) {
    return { ...result, ok: false, ...(error instanceof ObservationMismatch ? { failure: "assertion" as const, ...(mutant ? { mutationKilled: true } : {}) } : {}), error: error instanceof Error ? error.message : String(error) };
  }
}

const transportRunners = [
  runTierBStdioFixture,
  runTierBStdioLifecycleFixture,
  runTierBHttpPostFixture,
  runTierBHttpSseFixture,
  runTierBHttpHeadersFixture,
  runTierBHttpRedirectFixture,
  runTierBHttpStreamFixture,
];

/** First transport runner that owns the fixture wins; undefined = no owner. */
export async function runTierBTransportFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  for (const run of transportRunners) {
    const result = await run(fixture, mutant);
    if (result) return result;
  }
  return undefined;
}
