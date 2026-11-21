import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpClient, type JsonRpcRequest, type Transport } from "@mcp-client/core";
import {
  DiskSkillCache,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  MemorySkillCache,
  SKILL_CACHE_EXCLUDE_MARKER,
  SKILLS_EXTENSION_ID,
  SKILLS_REVISION,
  SkillsClient,
  SkillsExtension,
  createSkillsExtension,
  manifestFingerprint,
  parseYamlFrontmatter,
  sha256Hex,
  validateSkillEntry,
  verifyFileBytes,
  verifySkillMd,
  type SkillApprovalPort,
} from "../src/index.js";

function makeScriptedClient(
  handler: (req: JsonRpcRequest) => Record<string, unknown> | { error: { code: number; message: string } },
  serverKey = "srv",
) {
  const sent: JsonRpcRequest[] = [];
  const transport: Transport = {
    binding: "stdio",
    diagnostics: { async *[Symbol.asyncIterator]() {} },
    async notify() {},
    async close() {},
    start(req) {
      sent.push(req);
      const reply = handler(req);
      return {
        notifications: { async *[Symbol.asyncIterator]() {} },
        done: Promise.resolve({
          kind: "response",
          message: "error" in reply
            ? { jsonrpc: "2.0", id: req.id, error: reply.error as { code: number; message: string } }
            : { jsonrpc: "2.0", id: req.id, result: reply },
        }),
      };
    },
  };
  return { client: new McpClient({ transport, server: { key: serverKey } }), sent };
}

describe("@mcp-client/ext-skills", () => {
  it("exposes capability when healthy and working, and omits when unhealthy or not working", async () => {
    const ext = createSkillsExtension();
    expect(ext).toBeInstanceOf(SkillsExtension);
    expect(ext.id).toBe(SKILLS_EXTENSION_ID);
    expect(ext.version).toBe(SKILLS_REVISION);
    expect(ext.health()).toBe("working");
    expect(ext.settings()).toEqual({});
    expect(ext.capabilities(true)).toEqual({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
    expect(ext.capabilities(false)).toEqual({});

    const unhealthy = createSkillsExtension({ healthy: false });
    expect(unhealthy.health()).toBe("unhealthy");
    expect(unhealthy.settings()).toBeUndefined();
    expect(unhealthy.capabilities(true)).toEqual({});

    const seenCaps: unknown[] = [];
    const transport: Transport = {
      binding: "stdio",
      diagnostics: { async *[Symbol.asyncIterator]() {} },
      async notify() {},
      async close() {},
      start(msg) {
        seenCaps.push((msg.params?._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/clientCapabilities"]);
        return {
          notifications: { async *[Symbol.asyncIterator]() {} },
          done: Promise.resolve({ kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: {} } }),
        };
      },
    };
    const core = new McpClient({ transport, server: { key: "skills-ext" }, extensions: [ext] });
    await core.request("ping", {});
    expect(seenCaps[0]).toEqual({ extensions: { [SKILLS_EXTENSION_ID]: {} } });
    await core.close();
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

    const overBytes = validateSkillEntry({
      uri: "skill://s/f",
      name: "f",
      description: "d",
      files: [{ uri: "skill://s/f/a.bin", size: MAX_SKILL_BYTES + 1, sha256: h }],
    });
    expect(overBytes.ok).toBe(false);
    if (!overBytes.ok) expect(overBytes.kind).toBe("limit-exceeded");

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

  it("gates SkillsClient on capabilities, verifies reads, invalidates approval on manifest change, and enforces directoryRead policy", async () => {
    const md1 = "---\nname: lint\ndescription: Run linter\n---\n# Lint v1\n";
    const md2 = "---\nname: lint\ndescription: Run linter\n---\n# Lint v2\n";
    const b1 = Buffer.from(md1, "utf8");
    const b2 = Buffer.from(md2, "utf8");
    const h1 = sha256Hex(b1);
    const h2 = sha256Hex(b2);

    let activeDigest = h1;
    let activeSize = b1.byteLength;
    let servedText = md1;
    let crossAllowed = false;

    const { client, sent } = makeScriptedClient((req) => {
      if (req.method === "skills/list") {
        return {
          skills: [
            {
              uri: "skill://srv/lint",
              name: "lint",
              description: "Run linter",
              files: [
                { uri: "skill://srv/lint/SKILL.md", size: activeSize, sha256: activeDigest },
                { uri: "skill://srv/lint/extra.txt", size: 2, sha256: sha256Hex(Buffer.from("ok")) },
              ],
            },
          ],
        };
      }
      if (req.method === "skills/get") {
        return {
          skill: {
            uri: "skill://srv/lint",
            name: "lint",
            description: "Run linter",
            files: [{ uri: "skill://srv/lint/SKILL.md", size: activeSize, sha256: activeDigest }],
          },
        };
      }
      if (req.method === "resources/read") {
        return { contents: [{ uri: req.params?.["uri"], text: servedText }] };
      }
      if (req.method === "resources/directory/read") {
        return { uris: ["skill://srv/lint/SKILL.md", "skill://srv/lint/unlisted.txt"] };
      }
      return {};
    });

    const missingCaps = new SkillsClient({ client, capabilities: { extensions: { [SKILLS_EXTENSION_ID]: {} } } });
    expect((await missingCaps.list()).kind).toBe("capability-absent");
    expect(sent).toHaveLength(0);

    const badRev = new SkillsClient({
      client,
      capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: { revision: "1999-01-01" } } },
    });
    expect((await badRev.list()).kind).toBe("capability-absent");

    const approval: SkillApprovalPort = {
      approveLoad: async () => true,
      approveCrossServerRead: async () => crossAllowed,
    };
    const cache = new MemorySkillCache();
    const skills = new SkillsClient({
      client,
      capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: { revision: SKILLS_REVISION, directoryRead: true } } },
      approval,
      cache,
    });

    const listed = await skills.listAll();
    expect(listed.kind).toBe("ok");
    expect(skills.isKnownSkill("skill://srv/lint")).toBe(true);

    // Unapproved read fails locally without calling resources/read.
    const unapproved = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md");
    expect(unapproved.kind).toBe("protocol-violation");

    expect(await skills.approve("skill://srv/lint")).toBe(true);
    const read1 = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md");
    expect(read1).toMatchObject({ kind: "ok", value: { text: md1, fromCache: false } });

    const readCached = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md");
    expect(readCached).toMatchObject({ kind: "ok", value: { text: md1, fromCache: true } });

    // Cross-server read denied then allowed.
    const { client: otherClient } = makeScriptedClient(() => ({ contents: [{ uri: "skill://srv/lint/SKILL.md", text: md1 }] }), "other");
    const deniedCross = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md", {
      resourceServer: "other",
      resourceClient: otherClient,
    });
    expect(deniedCross.kind).toBe("protocol-violation");
    crossAllowed = true;
    const okCross = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md", {
      resourceServer: "other",
      resourceClient: otherClient,
    });
    expect(okCross.kind).toBe("ok");

    // Directory read filters out unlisted URIs, and requires directoryRead capability.
    const dirRes = await skills.readDirectory("skill://srv/lint", "skill://srv/lint");
    expect(dirRes).toMatchObject({ kind: "ok", value: { uris: ["skill://srv/lint/SKILL.md"] } });

    const noDirClient = new SkillsClient({
      client,
      capabilities: { resources: {}, extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: false } } },
    });
    expect((await noDirClient.readDirectory("skill://srv/lint", "skill://srv/lint")).kind).toBe("capability-absent");

    // Manifest update invalidates prior approval.
    activeDigest = h2;
    activeSize = b2.byteLength;
    servedText = md2;
    expect((await skills.get("skill://srv/lint")).kind).toBe("ok");
    const staleApproval = await skills.readFile("skill://srv/lint", "skill://srv/lint/SKILL.md");
    expect(staleApproval.kind).toBe("protocol-violation");

    await otherClient.close();
    await client.close();
  });
});
