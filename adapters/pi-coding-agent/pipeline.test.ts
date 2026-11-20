import { describe, expect, it, vi } from "vitest";
import {
  cancellableConsentPort,
  combineAbortSignals,
  runNestedTool,
  type NestedToolCall,
} from "./pipeline.js";

const call: NestedToolCall = {
  name: "mcp__srv__read",
  arguments: { path: "x" },
  parentToolCallId: "parent-42",
};

describe("runNestedTool [PICA-9]", () => {
  it("invokes only the host pipeline, once, preserving parentToolCallId and the call", async () => {
    const host = vi.fn(async (c: NestedToolCall, _signal: AbortSignal) => ({ ok: true, saw: c.parentToolCallId }));
    const directClient = vi.fn(async () => ({ ok: false }));
    void directClient; // nested calls must never bypass the host pipeline

    const result = await runNestedTool(host, call, new AbortController().signal, new AbortController().signal);

    expect(result).toEqual({ ok: true, saw: "parent-42" });
    expect(host).toHaveBeenCalledTimes(1);
    expect(host.mock.calls[0]![0]).toBe(call);
    expect(host.mock.calls[0]![0].parentToolCallId).toBe("parent-42");
    expect(host.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
    expect(directClient).not.toHaveBeenCalled();
    expect(call).toEqual({ name: "mcp__srv__read", arguments: { path: "x" }, parentToolCallId: "parent-42" });
  });

  it("supports a host pipeline object with an execute method", async () => {
    const host = { execute: vi.fn(async (c: NestedToolCall) => c.parentToolCallId) };
    await expect(runNestedTool(host, call)).resolves.toBe("parent-42");
    expect(host.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["parent", "session"] as const)("drops a late result when the %s signal aborts", async (which) => {
    const session = new AbortController();
    const parent = new AbortController();
    let finish!: (v: string) => void;
    let seenSignal!: AbortSignal;
    const host = vi.fn((_c: NestedToolCall, signal: AbortSignal) => {
      seenSignal = signal;
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const pending = runNestedTool(host, call, session.signal, parent.signal);
    (which === "parent" ? parent : session).abort(new Error(`stop-${which}`));
    expect(seenSignal.aborted).toBe(true);
    finish("late-result");
    await expect(pending).rejects.toThrow(`stop-${which}`);
  });

  it("does not invoke the host pipeline when already aborted", async () => {
    const parent = new AbortController();
    parent.abort();
    const host = vi.fn(async () => "x");
    await expect(runNestedTool(host, call, undefined, parent.signal)).rejects.toBe(parent.signal.reason);
    expect(host).not.toHaveBeenCalled();
  });

  it("propagates host errors and results when not aborted", async () => {
    const boom = new Error("denied by permission hook");
    await expect(runNestedTool(async () => { throw boom; }, call)).rejects.toBe(boom);
    await expect(runNestedTool(async () => 7, call)).resolves.toBe(7);
  });
});

describe("combineAbortSignals", () => {
  it("aborts when any input aborts and ignores missing signals", () => {
    const a = new AbortController();
    const combined = combineAbortSignals(undefined, a.signal, null);
    expect(combined).toBe(a.signal);
    const b = new AbortController();
    const both = combineAbortSignals(a.signal, b.signal);
    b.abort();
    expect(both.aborted).toBe(true);
    expect(combineAbortSignals().aborted).toBe(false);
  });
});

describe("cancellableConsentPort", () => {
  it("forwards the prompt with a combined signal and returns the decision", async () => {
    const inner = { request: vi.fn(async (_p: unknown, _s: AbortSignal) => ({ decision: "accept" as const })) };
    const parent = new AbortController();
    const port = cancellableConsentPort(inner, parent.signal);
    const prompt = { kind: "tool-call" as const, serverLabel: "srv" };
    await expect(port.request(prompt, new AbortController().signal)).resolves.toEqual({ decision: "accept" });
    expect(inner.request).toHaveBeenCalledTimes(1);
    expect(inner.request.mock.calls[0]![0]).toBe(prompt);
    expect(inner.request.mock.calls[0]![1].aborted).toBe(false);
  });

  it("drops a late accept when the parent aborts during the prompt", async () => {
    let decide!: (v: { decision: "accept" }) => void;
    const inner = { request: vi.fn(() => new Promise<{ decision: "accept" }>((r) => { decide = r; })) };
    const parent = new AbortController();
    const port = cancellableConsentPort(inner, parent.signal);
    const pending = port.request({ kind: "authorize", serverLabel: "srv" }, new AbortController().signal);
    parent.abort(new Error("parent gone"));
    decide({ decision: "accept" });
    await expect(pending).rejects.toThrow("parent gone");
  });

  it("never auto-approves when there is no inner port, and does not call inner when pre-aborted", async () => {
    await expect(
      cancellableConsentPort(undefined).request({ kind: "authorize", serverLabel: "s" }, new AbortController().signal),
    ).resolves.toEqual({ decision: "cancel" });

    const inner = { request: vi.fn(async (_p: unknown, _s: AbortSignal) => ({ decision: "accept" as const })) };
    const signal = new AbortController();
    signal.abort();
    await expect(
      cancellableConsentPort(inner).request({ kind: "authorize", serverLabel: "s" }, signal.signal),
    ).rejects.toBe(signal.signal.reason);
    expect(inner.request).not.toHaveBeenCalled();
  });
});
