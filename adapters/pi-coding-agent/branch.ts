/** Versioned session namespace, intentionally incompatible with legacy branches. */
export const BRANCH_CUSTOM_TYPE = "pi.coding-agent.branch.v2";

export interface BranchState {
  cursor?: string | null;
  approval?: string | null;
  taskId?: string | null;
  // Manual MRTR requestState – persisted only when explicitly set.
  requestState?: string | null;
}

export interface BranchCustomEntry {
  readonly type: "custom";
  readonly customType: typeof BRANCH_CUSTOM_TYPE;
  readonly data: BranchState;
  readonly id?: string;
  readonly parentId?: string | null;
  readonly timestamp?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const ALLOWLIST = ["cursor", "approval", "taskId", "requestState"] as const;

function pickAllowlisted(state: unknown): BranchState {
  const out: BranchState = {};
  if (!isRecord(state)) return out;
  for (const key of ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
    const value = state[key];
    if (typeof value === "string" || value === null) out[key] = value;
  }
  return out;
}

export function encodeBranch(state: BranchState): BranchCustomEntry {
  return { type: "custom", customType: BRANCH_CUSTOM_TYPE, data: pickAllowlisted(state) };
}

/** Restore the latest matching entry on this branch; empty data clears prior state. */
export function decodeBranch(entries: readonly unknown[]): BranchState | undefined {
  let latest: BranchState | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== BRANCH_CUSTOM_TYPE) continue;
    if (isRecord(entry.data)) latest = pickAllowlisted(entry.data);
  }
  return latest;
}
