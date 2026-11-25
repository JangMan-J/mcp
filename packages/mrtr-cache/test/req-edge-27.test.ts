import { describe, it, expect } from "vitest";
import type { Outcome } from "@mcp/core";
import { MrtrSession, type RequestFn } from "../src/index.js";

const meta = { binding: "stdio", requestId: 1, method: "tools/call", attempts: 1 };

describe("EDGE-27", () => {
  it("[EDGE-27] process exits during a consent wait -> transport-failure and consent aborted", async () => {
    // Fake stdio transport: its process "exits" by aborting the closed signal.
    const processExit = new AbortController();
    const request: RequestFn = async () =>
      ({
        kind: "ok",
        value: {
          resultType: "input_required",
          inputRequests: {
            f: {
              method: "elicitation/create",
              params: {
                message: "confirm",
                requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
        meta,
      }) as Outcome<unknown>;
    let consentSignal: AbortSignal | undefined;
    let waiting!: () => void;
    const entered = new Promise<void>((r) => (waiting = r));
    const m = new MrtrSession(request, {
      serverLabel: "s",
      transportClosed: processExit.signal,
      port: {
        form: (_req, signal) => {
          consentSignal = signal;
          waiting();
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
      },
    });
    const run = m.run("tools/call", { name: "t" });
    await entered;
    processExit.abort({ kind: "process-exit", message: "child exited with code 1" });
    const out = await Promise.race([
      run,
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 1000)),
    ]);
    expect(consentSignal?.aborted).toBe(true);
    expect(out).toMatchObject({
      kind: "transport-failure",
      failure: { kind: "process-exit" },
    });
  });
});
