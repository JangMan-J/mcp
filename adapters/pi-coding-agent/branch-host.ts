// Public host helpers for namespaced branch persistence.
//
// Adapter composition wires these to Pi's session surface later. This
// module owns no protocol or credential logic: it only encodes state
// through the allowlist in branch.ts, appends it under the versioned
// namespace, and restores the latest snapshot on the *active* branch.

import {
  BRANCH_CUSTOM_TYPE,
  decodeBranch,
  encodeBranch,
  type BranchCustomEntry,
  type BranchState,
} from "./branch.js";

export { BRANCH_CUSTOM_TYPE };
export type { BranchCustomEntry, BranchState };

/**
 * Minimal Pi-like session surface needed for branch persistence
 * (fakeable, no live Pi import). `appendEntry` mirrors Pi: it appends a
 * custom entry and returns its entry id. `getBranch` must return only
 * the entries on the active branch, root-first — not every entry in
 * the session tree.
 */
export interface BranchSessionPort {
  appendEntry(customType: typeof BRANCH_CUSTOM_TYPE, data: BranchState): string | void;
  getBranch(): readonly unknown[];
}

/** Typed branch helpers bound to one session/branch host. */
export interface BranchHost {
  /**
   * Encode `state` (allowlisted fields only; tokens/credentials and any
   * other extra fields are dropped) and append it under
   * BRANCH_CUSTOM_TYPE. Returns the encoded entry, carrying the host
   * entry id when the host provides one.
   */
  appendEntry(state: BranchState): BranchCustomEntry;
  /**
   * Restore the latest branch snapshot. With no arguments, reads only
   * the host's active branch (`getBranch()`). With explicit entries,
   * pass `leafId` to restrict a full session entry list to the active
   * path ending at that leaf; without it the list is taken as already
   * being the active branch.
   */
  restoreBranch(entries?: readonly unknown[], leafId?: string | null): BranchState | undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Reduce a full session entry list to the active branch ending at
 * `leafId`, root-first, by walking `parentId` links. Entries on sibling
 * forks are excluded. Returns an empty list when the leaf is unknown,
 * so restore fails closed instead of leaking a sibling fork's state.
 * Without a `leafId`, `entries` is returned unchanged (already active).
 */
export function activeBranchEntries(
  entries: readonly unknown[],
  leafId?: string | null,
): readonly unknown[] {
  if (leafId === undefined || leafId === null) return entries;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const chain: unknown[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current !== undefined) {
    const id = current.id as string;
    if (seen.has(id)) break; // cycle: stop rather than loop forever
    seen.add(id);
    chain.push(current);
    const parentId = current.parentId;
    current = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  return chain.reverse();
}

/** Append an allowlisted, namespaced branch entry via `host`. */
export function appendEntry(host: BranchSessionPort, state: BranchState): BranchCustomEntry {
  const encoded = encodeBranch(state);
  // Only the allowlisted data crosses to the host: no tokens, no
  // credential-store contents, no arbitrary spread of the input state.
  const id = host.appendEntry(encoded.customType, encoded.data);
  return typeof id === "string" ? { ...encoded, id } : encoded;
}

export function restoreBranch(host: BranchSessionPort): BranchState | undefined;
export function restoreBranch(
  entries: readonly unknown[],
  leafId?: string | null,
): BranchState | undefined;
/**
 * Restore the latest branch snapshot from a host's active branch, or
 * from an explicit entry list (optionally restricted to the active
 * path ending at `leafId` when given the full session entry list).
 */
export function restoreBranch(
  source: BranchSessionPort | readonly unknown[],
  leafId?: string | null,
): BranchState | undefined {
  if (Array.isArray(source)) return decodeBranch(activeBranchEntries(source, leafId));
  return decodeBranch(source.getBranch());
}

/** Bind the typed branch helpers to a Pi-like session host. */
export function createBranchHost(host: BranchSessionPort): BranchHost {
  return {
    appendEntry: (state) => appendEntry(host, state),
    restoreBranch: (entries, leafId) =>
      entries === undefined ? restoreBranch(host) : decodeBranch(activeBranchEntries(entries, leafId)),
  };
}
