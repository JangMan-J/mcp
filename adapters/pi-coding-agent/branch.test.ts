import { describe, it, expect } from "vitest";
import { type BranchState, BRANCH_CUSTOM_TYPE, encodeBranch, decodeBranch } from "./branch.js";

describe("branch persistence (namespaced, allowlisted)", () => {
  it("encodes only allowlisted fields", () => {
    const state = {
      cursor: "c1",
      approval: "approved",
      taskId: "t-123",
      requestState: "manual-state",
      // injected extras that must not be persisted
      credentials: { token: "secret" },
      accessToken: "should-not-persist",
      extra: "drop me",
      nested: { foo: "bar" },
    } as unknown as BranchState & Record<string, unknown>;

    const entry = encodeBranch(state as BranchState);
    expect(entry.type).toBe("custom");
    expect(entry.customType).toBe(BRANCH_CUSTOM_TYPE);
    expect(entry.data).toEqual({
      cursor: "c1",
      approval: "approved",
      taskId: "t-123",
      requestState: "manual-state",
    });
    // ensure no credential or arbitrary keys leaked
    expect((entry.data as Record<string, unknown>).credentials).toBeUndefined();
    expect((entry.data as Record<string, unknown>).accessToken).toBeUndefined();
    expect((entry.data as Record<string, unknown>).extra).toBeUndefined();
  });

  it("drops non-string allowlisted types and cleans credential-like injection", () => {
    const state = {
      cursor: "cursor-val",
      approval: { token: "secret", id: "a1" }, // object approval should be dropped
      taskId: 123 as unknown as string,
      requestState: undefined,
      token: "leak",
    } as unknown as BranchState & Record<string, unknown>;
    const entry = encodeBranch(state as BranchState);
    // only string cursor survives; approval as object is dropped, taskId non-string dropped
    expect(entry.data).toEqual({ cursor: "cursor-val" });
  });

  it("ignores inherited fields and keeps explicit null on encode and decode", () => {
    const state = Object.assign(Object.create({ approval: "inherited" }), { cursor: null });
    expect(encodeBranch(state).data).toEqual({ cursor: null });
    expect(decodeBranch([{ type: "custom", customType: BRANCH_CUSTOM_TYPE, data: state }])).toEqual({ cursor: null });
  });

  it("namespace incompatible with legacy", () => {
    expect(BRANCH_CUSTOM_TYPE).not.toBe("branch");
    expect(BRANCH_CUSTOM_TYPE).not.toBe("mcp.branch");
    expect(BRANCH_CUSTOM_TYPE).not.toBe("mcp-branch");
    expect(BRANCH_CUSTOM_TYPE.length).toBeGreaterThan("branch".length);
  });

  it("decode restores latest matching data and ignores legacy", () => {
    const legacy = { type: "custom", customType: "branch", data: { cursor: "legacy", taskId: "old" } };
    const e1 = encodeBranch({ cursor: "first", taskId: "t1" });
    const e2 = encodeBranch({ cursor: "second", taskId: "t2", approval: "ok" });
    const entries = [legacy, e1, e2] as unknown[];
    const decoded = decodeBranch(entries);
    expect(decoded).toEqual({ cursor: "second", taskId: "t2", approval: "ok" });
  });

  it("decode strips injected extra credential fields inside data", () => {
    const injected = {
      type: "custom",
      customType: BRANCH_CUSTOM_TYPE,
      data: {
        cursor: "c",
        approval: "a",
        taskId: "t",
        requestState: "rs",
        credentials: { access_token: "secret" },
        token: "secret",
        extraField: "evil",
      },
    };
    const decoded = decodeBranch([injected] as unknown[]);
    expect(decoded).toEqual({ cursor: "c", approval: "a", taskId: "t", requestState: "rs" });
  });

  it("decode returns undefined when no matching namespace", () => {
    const entries = [
      { type: "custom", customType: "branch", data: { cursor: "x" } },
      { type: "custom", customType: "mcp.branch", data: { cursor: "y" } },
      { type: "message", customType: BRANCH_CUSTOM_TYPE, data: { cursor: "z" } },
    ] as unknown[];
    expect(decodeBranch(entries)).toBeUndefined();
  });

  it("fork isolation: separate entry arrays decode independently", () => {
    const forkA = [encodeBranch({ cursor: "A", taskId: "ta" })] as unknown[];
    const forkB = [encodeBranch({ cursor: "B", taskId: "tb" })] as unknown[];
    // Add extra entry to A after fork
    const forkAAfter = [...forkA, encodeBranch({ cursor: "A2", taskId: "ta2" })] as unknown[];

    expect(decodeBranch(forkA)).toEqual({ cursor: "A", taskId: "ta" });
    expect(decodeBranch(forkB)).toEqual({ cursor: "B", taskId: "tb" });
    expect(decodeBranch(forkAAfter)).toEqual({ cursor: "A2", taskId: "ta2" });
    // B unaffected by A's later entry
    expect(decodeBranch(forkB)).toEqual({ cursor: "B", taskId: "tb" });
  });

  it("encode does not persist arbitrary spreading or credential store contents", () => {
    const stateWithCreds = {
      cursor: "keep",
      approval: "keep2",
      credentials: { refresh_token: "r", access_token: "a" },
      token: "t",
      secret: "s",
      password: "p",
    } as unknown as BranchState & Record<string, unknown>;
    const entry = encodeBranch(stateWithCreds as BranchState);
    const json = JSON.stringify(entry);
    expect(json).not.toContain("refresh_token");
    expect(json).not.toContain("access_token");
    expect(json).not.toContain("secret");
    expect((entry.data as Record<string, unknown>).credentials).toBeUndefined();
  });

  it("roundtrip preserves allowlisted fields and drops injected on decode", () => {
    const original: BranchState = { cursor: "cur", approval: "ap", taskId: "tid", requestState: "mrs" };
    const entry = encodeBranch(original);
    // Simulate injected extra credential fields added after encode (tampering)
    const tampered = {
      ...entry,
      data: { ...entry.data, injectedToken: "bad", credentials: "bad2" },
    } as unknown;
    const decoded = decodeBranch([tampered] as unknown[]);
    expect(decoded).toEqual(original);
  });
});
