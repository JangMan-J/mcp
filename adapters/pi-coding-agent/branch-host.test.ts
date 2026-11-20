import { describe, expect, it } from "vitest";
import { BRANCH_CUSTOM_TYPE, type BranchState } from "./branch.js";
import {
  activeBranchEntries,
  appendEntry,
  createBranchHost,
  restoreBranch,
  type BranchSessionPort,
} from "./branch-host.js";

/** In-memory Pi-like session: a tree of entries with an active leaf. */
class FakeSession implements BranchSessionPort {
  entries: Record<string, unknown>[] = [];
  appended: { customType: string; data: unknown }[] = [];
  private seq = 0;
  leafId: string | null = null;

  appendEntry(customType: typeof BRANCH_CUSTOM_TYPE, data: BranchState): string {
    this.appended.push({ customType, data });
    const id = `e${++this.seq}`;
    this.entries.push({ type: "custom", customType, data, id, parentId: this.leafId });
    this.leafId = id;
    return id;
  }

  /** Active branch only, root-first (walks parentId from the leaf). */
  getBranch(): readonly unknown[] {
    return activeBranchEntries(this.entries, this.leafId);
  }

  /** Fork: move the active leaf back to an earlier entry. */
  forkAt(id: string | null): void {
    this.leafId = id;
  }
}

describe("branch host helpers", () => {
  it("appendEntry appends under the namespace and returns the encoded entry with host id", () => {
    const session = new FakeSession();
    const host = createBranchHost(session);
    const entry = host.appendEntry({ cursor: "c1", taskId: "t1" });
    expect(entry.customType).toBe(BRANCH_CUSTOM_TYPE);
    expect(entry.type).toBe("custom");
    expect(entry.id).toBe("e1");
    expect(session.appended).toEqual([{ customType: BRANCH_CUSTOM_TYPE, data: { cursor: "c1", taskId: "t1" } }]);
  });

  it("restoreBranch returns the latest snapshot from the active branch only", () => {
    const session = new FakeSession();
    const host = createBranchHost(session);
    host.appendEntry({ cursor: "first", taskId: "t1" });
    host.appendEntry({ cursor: "second", taskId: "t2", approval: "ok" });
    expect(host.restoreBranch()).toEqual({ cursor: "second", taskId: "t2", approval: "ok" });
    expect(restoreBranch(session)).toEqual({ cursor: "second", taskId: "t2", approval: "ok" });
  });

  it("restoreBranch is undefined before any namespaced entry", () => {
    const session = new FakeSession();
    session.entries.push({ type: "custom", customType: "branch", data: { cursor: "legacy" }, id: "x", parentId: null });
    session.leafId = "x";
    expect(createBranchHost(session).restoreBranch()).toBeUndefined();
  });

  it("fork isolation: a fork does not see a sibling branch's later entries", () => {
    const session = new FakeSession();
    const host = createBranchHost(session);
    host.appendEntry({ cursor: "shared", taskId: "base" }); // e1
    host.appendEntry({ cursor: "A", taskId: "ta" }); // e2, branch A leaf
    const branchALeaf = session.leafId;

    session.forkAt("e1");
    host.appendEntry({ cursor: "B", taskId: "tb" }); // e3, child of e1 (fork B)
    expect(host.restoreBranch()).toEqual({ cursor: "B", taskId: "tb" });

    // Branch A's snapshot is unchanged, both via its leaf over the full
    // entry list and by switching the active leaf back.
    expect(restoreBranch(session.entries, branchALeaf)).toEqual({ cursor: "A", taskId: "ta" });
    session.forkAt(branchALeaf);
    expect(host.restoreBranch()).toEqual({ cursor: "A", taskId: "ta" });

    // Two independent hosts do not share state at all.
    const other = createBranchHost(new FakeSession());
    other.appendEntry({ cursor: "other", taskId: "to" });
    expect(other.restoreBranch()).toEqual({ cursor: "other", taskId: "to" });
    expect(host.restoreBranch()).toEqual({ cursor: "A", taskId: "ta" });
  });

  it("activeBranchEntries selects only the active path from all entries", () => {
    const session = new FakeSession();
    const host = createBranchHost(session);
    host.appendEntry({ cursor: "root" });
    host.appendEntry({ cursor: "A" });
    session.forkAt("e1");
    host.appendEntry({ cursor: "B" }); // later in the full list, sibling fork
    // Decoding the full list would pick B; the active path must not.
    expect(host.restoreBranch(session.entries, "e2")).toEqual({ cursor: "A" });
    expect(activeBranchEntries(session.entries, "nope")).toEqual([]);
    expect(host.restoreBranch(session.entries, "nope")).toBeUndefined();
  });

  it("no token persistence: injected credential fields never reach the host or a restore", () => {
    const session = new FakeSession();
    const state = {
      cursor: "c",
      taskId: "t",
      accessToken: "secret-token",
      credentials: { refresh_token: "secret-refresh" },
      secret: "s",
    } as unknown as BranchState;
    const entry = appendEntry(session, state);
    expect(JSON.stringify(entry)).not.toContain("secret");
    expect(JSON.stringify(session.appended)).not.toContain("secret");
    expect(session.appended[0]?.data).toEqual({ cursor: "c", taskId: "t" });
    expect(restoreBranch(session)).toEqual({ cursor: "c", taskId: "t" });
    // Tampered entries restored later are re-allowlisted too.
    expect(
      restoreBranch([
        { type: "custom", customType: BRANCH_CUSTOM_TYPE, data: { cursor: "c2", token: "leak" } },
      ]),
    ).toEqual({ cursor: "c2" });
  });
});
