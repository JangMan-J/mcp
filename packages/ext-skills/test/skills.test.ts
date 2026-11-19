import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DiskSkillCache,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MemorySkillCache,
  SKILL_CACHE_EXCLUDE_MARKER,
  SKILLS_EXTENSION_ID,
  SKILLS_PIN,
  SkillsExtension,
  createSkillsExtension,
  manifestFingerprint,
  parseYamlFrontmatter,
  sha256Hex,
  validateSkillEntry,
  verifyFileBytes,
  verifySkillMd,
} from "../src/index.js";
import { ObservationMismatch, runExchange, supportsMutant } from "../src/conformance.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "../../fixtures/exchanges/ext/skills");
const REQ_PATH = join(HERE, "../../conformance/requirements.json");

describe("@mcp-client/ext-skills", () => {
  it("satisfies EXT-REG-1, EXT-STAGE-1, and EXT-PIN-1", () => {
    const ext = createSkillsExtension();
    expect(ext).toBeInstanceOf(SkillsExtension);
    expect(ext.id).toBe(SKILLS_EXTENSION_ID);
    expect(ext.stage).toBe("beta");
    expect(ext.defaultEnabled).toBe(false);
    expect(ext.pin.commit).toBe("649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a");
    expect(ext.health()).toBe("working");
    expect(ext.settings()).toEqual({});
    expect(ext.capabilities(true)).toEqual({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
    expect(ext.capabilities(false)).toEqual({});

    const unhealthy = createSkillsExtension({ healthy: false });
    expect(unhealthy.health()).toBe("unhealthy");
    expect(unhealthy.settings()).toBeUndefined();
    expect(unhealthy.capabilities(true)).toEqual({});

    const pinMd = readFileSync(join(HERE, "../PIN.md"), "utf8");
    expect(pinMd).toContain(SKILLS_PIN.commit);
    expect(pinMd).toContain(SKILLS_PIN.wikiCommit);
  });

  it("verifies SHA-256, byte length, and YAML frontmatter vectors", () => {
    const md = "---\nname: lint\ndescription: Run linter\nallowed-tools:\n  - read_file\n---\n# Lint\n";
    const bytes = Buffer.from(md, "utf8");
    const digest = sha256Hex(bytes);
    expect(verifyFileBytes(bytes, { uri: "skill://s/lint/SKILL.md", size: bytes.byteLength, sha256: digest }).ok).toBe(true);
    expect(verifyFileBytes(bytes, { uri: "skill://s/lint/SKILL.md", size: bytes.byteLength + 1, sha256: digest }).ok).toBe(false);
    expect(verifyFileBytes(bytes, { uri: "skill://s/lint/SKILL.md", size: bytes.byteLength, sha256: "0".repeat(64) }).ok).toBe(false);

    const fm = parseYamlFrontmatter(md);
    expect(fm).toEqual({ name: "lint", description: "Run linter", "allowed-tools": ["read_file"] });

    const entry = {
      uri: "skill://s/lint",
      name: "lint",
      description: "Run linter",
      allowedTools: ["read_file"],
      files: [{ uri: "skill://s/lint/SKILL.md", size: bytes.byteLength, sha256: digest }],
    };
    expect(verifySkillMd("skill://s/lint/SKILL.md", md, entry).ok).toBe(true);
    expect(verifySkillMd("skill://s/wrong-dir/SKILL.md", md, entry).ok).toBe(false);
    expect(verifySkillMd("skill://s/lint/SKILL.md", md.replace("Run linter", "Other"), entry).ok).toBe(false);
  });

  it("enforces 512 files and 16 MiB limits and manifest fingerprint sensitivity", () => {
    const h = sha256Hex(Buffer.from("x", "utf8"));
    const makeFiles = (n: number) => Array.from({ length: n }, (_, i) => ({ uri: `skill://s/f/${i}.txt`, size: 1, sha256: h }));

    expect(validateSkillEntry({ uri: "skill://s/f", name: "f", description: "d", files: makeFiles(MAX_SKILL_FILES) }).ok).toBe(true);
    const overFiles = validateSkillEntry({ uri: "skill://s/f", name: "f", description: "d", files: makeFiles(MAX_SKILL_FILES + 1) });
    expect(overFiles.ok).toBe(false);
    if (!overFiles.ok) expect(overFiles.kind).toBe("limit-exceeded");

    const atBytes = validateSkillEntry({
      uri: "skill://s/f",
      name: "f",
      description: "d",
      files: [{ uri: "skill://s/f/a.bin", size: MAX_SKILL_BYTES, sha256: h }],
    });
    expect(atBytes.ok).toBe(true);

    const fp1 = manifestFingerprint([{ uri: "a", size: 1, sha256: h }, { uri: "b", size: 2, sha256: h }]);
    const fp2 = manifestFingerprint([{ uri: "b", size: 2, sha256: h }, { uri: "a", size: 1, sha256: h }]);
    const fp3 = manifestFingerprint([{ uri: "a", size: 1, sha256: h }, { uri: "b", size: 3, sha256: h }]);
    expect(fp1).toBe(fp2);
    expect(fp1).not.toBe(fp3);
  });

  it("detects tampering in MemorySkillCache and DiskSkillCache and preserves MCP origin across restart", () => {
    const bytes = new Uint8Array(Buffer.from("hello skill", "utf8"));
    const sha = sha256Hex(bytes);

    const mem = new MemorySkillCache();
    mem.set({ origin: { kind: "mcp", serverKey: "srv", skillUri: "skill://s/1" }, uri: "skill://s/1/a.txt", size: bytes.byteLength, sha256: sha, bytes });
    expect(mem.get("srv", "skill://s/1", "skill://s/1/a.txt", bytes.byteLength, sha)?.bytes).toEqual(bytes);
    expect(mem.get("srv", "skill://s/1", "skill://s/1/a.txt", bytes.byteLength, "f".repeat(64))).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), "ext-skills-cache-test-"));
    try {
      const disk1 = new DiskSkillCache(dir);
      expect(existsSync(join(dir, SKILL_CACHE_EXCLUDE_MARKER))).toBe(true);
      disk1.set({ origin: { kind: "mcp", serverKey: "srv", skillUri: "skill://s/1" }, uri: "skill://s/1/a.txt", size: bytes.byteLength, sha256: sha, bytes });

      const disk2 = new DiskSkillCache(dir);
      expect(disk2.getOrigin("srv", "skill://s/1", "skill://s/1/a.txt")).toEqual({ kind: "mcp", serverKey: "srv", skillUri: "skill://s/1" });
      expect(disk2.get("srv", "skill://s/1", "skill://s/1/a.txt", bytes.byteLength, sha)?.bytes).toEqual(bytes);

      const binFile = readdirSync(dir).find((f) => f.endsWith(".bin"))!;
      writeFileSync(join(dir, binFile), "tampered!!!", "utf8");
      expect(disk2.get("srv", "skill://s/1", "skill://s/1/a.txt", bytes.byteLength, sha)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs all 6 Tier A fixtures, kills every mutant with ObservationMismatch, and resolves all requirement IDs", async () => {
    const reqDoc = JSON.parse(readFileSync(REQ_PATH, "utf8")) as { rows: Array<{ id: string }> };
    const knownReqs = new Set(reqDoc.rows.map((r) => r.id));

    const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".exchange.json")).sort();
    expect(files.length).toBe(6);

    for (const file of files) {
      const fx = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as {
        id: string;
        requirements: string[];
        mutants: string[];
      };
      for (const reqId of fx.requirements) {
        expect(knownReqs.has(reqId), `unknown requirement ${reqId} in ${file}`).toBe(true);
      }
      await runExchange(fx);
      expect(fx.mutants.length).toBeGreaterThan(0);
      for (const mutant of fx.mutants) {
        expect(supportsMutant(mutant), `unsupported mutant ${mutant} in ${file}`).toBe(true);
        await expect(runExchange(fx, mutant)).rejects.toThrow(ObservationMismatch);
      }
    }
  });
});
