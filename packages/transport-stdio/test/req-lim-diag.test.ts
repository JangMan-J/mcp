import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_DIAGNOSTICS, DiagnosticChannel, type TransportDiagnostic } from "@mcp-client/core";

const diag = (i: number): TransportDiagnostic => ({ kind: "noise", message: `n${i}`, atMs: i });

describe("[LIM-DIAG-1] diagnostic ring is bounded: 1000 events", () => {
  it("default bound is 1000", () => {
    expect(DEFAULT_MAX_DIAGNOSTICS).toBe(1000);
  });

  it("retains only the newest 1000 when unconsumed (ring and live queue)", async () => {
    const ch = new DiagnosticChannel();
    const total = 2500;
    for (let i = 0; i < total; i++) ch.emit(diag(i));

    const snap = ch.snapshot();
    expect(snap.length).toBe(1000);
    expect(snap[0]!.message).toBe(`n${total - 1000}`);
    expect(snap[999]!.message).toBe(`n${total - 1}`);

    ch.close();
    const drained: TransportDiagnostic[] = [];
    for await (const d of ch) drained.push(d);
    expect(drained.length).toBe(1000);
    expect(drained[0]!.message).toBe(`n${total - 1000}`);
    expect(drained[999]!.message).toBe(`n${total - 1}`);
  });

  it("bound is configurable", () => {
    const ch = new DiagnosticChannel(3);
    for (let i = 0; i < 10; i++) ch.emit(diag(i));
    expect(ch.snapshot().map((d) => d.message)).toEqual(["n7", "n8", "n9"]);
  });
});
