import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), "utf8");

const FEATURES = [
  { name: "Roots", row: "DEP-ROOTS-1", wire: ["roots/list", "notifications/roots/list_changed"] },
  { name: "Sampling", row: "DEP-SAMPLING-1", wire: ["sampling/createMessage"] },
  { name: "Logging", row: "DEP-LOG-1", wire: ["logging/setLevel", "io.modelcontextprotocol/logLevel"] },
  { name: "Dynamic Client Registration", row: "DEP-DCR-1", wire: ['"registration"'] },
  { name: "includeContext thisServer/allServers", row: "DEP-INCLUDECTX-1", wire: ["includeContext"] },
  { name: "HTTP+SSE", row: "DEP-HTTPSSE-1", wire: ["last-event-id"] },
];

/** Parse "Registry rows: A, B, C." out of a DEP-CONFIRM-1 table line. */
export function parseRegistry(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("| DEP-CONFIRM-1 "));
  const m = line?.match(/Registry rows: ([^.|]+?)\./);
  if (!m) throw new Error("DEP-CONFIRM-1 registry list not found");
  return m[1].split(",").map((s) => s.trim());
}

/** Returns problems comparing a parsed registry with the expected six. */
export function registryProblems(parsed: string[]): string[] {
  const want = FEATURES.map((f) => f.name);
  return [
    ...parsed.filter((p) => !want.includes(p)).map((p) => `unexpected feature: ${p}`),
    ...want.filter((w) => !parsed.includes(w)).map((w) => `missing feature: ${w}`),
  ];
}

describe("[DEP-CONFIRM-1] deprecated registry confirmation", () => {
  const pins = read("docs/conformance/PINS.md");
  const reqMd = read("docs/conformance/requirements.md");
  const opsMd = read("docs/conformance/operations.md");
  const json = JSON.parse(read("packages/conformance/requirements.json")) as {
    rows: { id: string; disposition: string; condition: string; acceptanceCheck: string }[];
  };

  it("[DEP-CONFIRM-1] pins record spec tag 5f5440bb and docs@de3550c9", () => {
    expect(pins).toMatch(/spec tag[^\n]*`5f5440bb[0-9a-f]{32}`/);
    expect(pins).toMatch(/wiki docs mirror[^\n]*`de3550c9[0-9a-f]{32}`/);
    for (const doc of [reqMd, opsMd]) {
      expect(doc).toContain("Re-read at tag 5f5440bb and wiki docs@de3550c9");
    }
    const row = json.rows.find((r) => r.id === "DEP-CONFIRM-1");
    expect(row?.acceptanceCheck).toBe("doc check dep-confirm-tag-5f5440bb");
    expect(row?.condition).toContain("5f5440bb");
    expect(row?.condition).toContain("de3550c9");
  });

  it("[DEP-CONFIRM-1] registry is exactly the six features, in both docs", () => {
    for (const doc of [reqMd, opsMd]) {
      expect(registryProblems(parseRegistry(doc))).toEqual([]);
      expect(parseRegistry(doc)).toHaveLength(6);
    }
  });

  it("[DEP-CONFIRM-1] each feature has its DEP-* row with disposition deprecated", () => {
    for (const f of FEATURES) {
      const row = json.rows.find((r) => r.id === f.row);
      expect(row, f.row).toBeDefined();
      expect(row?.disposition, f.row).toBe("deprecated");
      expect(reqMd).toContain(`| ${f.row} |`);
    }
    const deprecated = json.rows.filter((r) => r.disposition === "deprecated").map((r) => r.id);
    expect(deprecated.sort()).toEqual(FEATURES.map((f) => f.row).sort());
  });

  it("[DEP-CONFIRM-1] wire-scan forbids each deprecated construct", () => {
    const scan = read("scripts/wire-scan.mjs").toLowerCase();
    for (const f of FEATURES) {
      for (const token of f.wire) expect(scan, `${f.name}: ${token}`).toContain(token.toLowerCase());
    }
  });

  it("[DEP-CONFIRM-1] self-check: parser flags a 7th or missing feature", () => {
    const base = FEATURES.map((f) => f.name);
    expect(registryProblems(base)).toEqual([]);
    expect(registryProblems([...base, "Tasks"])).toEqual(["unexpected feature: Tasks"]);
    expect(registryProblems(base.slice(1))).toEqual([`missing feature: ${base[0]}`]);
    const line = "| DEP-CONFIRM-1 | x | Registry rows: Roots, Sampling, Tasks. Heading |";
    expect(parseRegistry(line)).toEqual(["Roots", "Sampling", "Tasks"]);
    expect(() => parseRegistry("nothing")).toThrow();
  });
});
