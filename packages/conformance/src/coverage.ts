import { readFileSync } from "node:fs";
import { loadExchangeFiles } from "@mcp-client/fixtures";

export interface RequirementRow {
  readonly id: string;
  readonly disposition: string;
  readonly acceptanceCheck: string;
}

export interface CoverageReport {
  readonly ok: boolean;
  readonly requirementCount: number;
  readonly fixtureCount: number;
  readonly errors: readonly string[];
}

export function checkCoverage(requirementsJsonPath: string, exchangesDir: string): CoverageReport {
  const reqDoc = JSON.parse(readFileSync(requirementsJsonPath, "utf8")) as {
    rows?: RequirementRow[];
  };
  const rows = reqDoc.rows ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fixtures = loadExchangeFiles(exchangesDir);
  const errors: string[] = [];

  for (const fx of fixtures) {
    if (fx.requirements.length === 0) {
      errors.push(`fixture ${fx.id} declares zero requirement IDs`);
    }
    if (fx.mutants.length === 0) {
      errors.push(`fixture ${fx.id} declares zero mutants (FIX-2)`);
    }
    for (const rid of fx.requirements) {
      const row = byId.get(rid);
      if (!row) {
        errors.push(`fixture ${fx.id} references unknown requirement ID '${rid}'`);
        continue;
      }
      if (row.disposition === "unresolved" || row.disposition === "unresolved-pending-pin") {
        errors.push(`fixture ${fx.id} targets unresolved requirement '${rid}'`);
      }
    }
  }

  for (const r of rows) {
    if (r.disposition && !r.acceptanceCheck.trim()) {
      errors.push(`requirement ${r.id} has empty acceptanceCheck`);
    }
  }

  return {
    ok: errors.length === 0,
    requirementCount: rows.length,
    fixtureCount: fixtures.length,
    errors,
  };
}
