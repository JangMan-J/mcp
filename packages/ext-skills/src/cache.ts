import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_CACHE_EXCLUDE_MARKER, sha256Hex, type SkillCacheEntry, type SkillOrigin } from "./verify.js";

export interface SkillCache {
  get(serverKey: string, skillUri: string, fileUri: string, expectedSize: number, expectedSha256: string): SkillCacheEntry | undefined;
  set(entry: SkillCacheEntry): void;
  getOrigin(serverKey: string, skillUri: string, fileUri: string): SkillOrigin | undefined;
}

function cacheKey(serverKey: string, skillUri: string, fileUri: string): string {
  return sha256Hex(Buffer.from(`${serverKey}\0${skillUri}\0${fileUri}`, "utf8"));
}

export class MemorySkillCache implements SkillCache {
  private readonly entries = new Map<string, SkillCacheEntry>();

  get(serverKey: string, skillUri: string, fileUri: string, expectedSize: number, expectedSha256: string): SkillCacheEntry | undefined {
    const key = cacheKey(serverKey, skillUri, fileUri);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (
      entry.origin.kind !== "mcp" ||
      entry.origin.serverKey !== serverKey ||
      entry.origin.skillUri !== skillUri ||
      entry.uri !== fileUri ||
      entry.size !== expectedSize ||
      entry.sha256 !== expectedSha256 ||
      entry.bytes.byteLength !== expectedSize ||
      sha256Hex(entry.bytes) !== expectedSha256
    ) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(entry: SkillCacheEntry): void {
    const key = cacheKey(entry.origin.serverKey, entry.origin.skillUri, entry.uri);
    this.entries.set(key, {
      ...entry,
      bytes: new Uint8Array(entry.bytes),
    });
  }

  getOrigin(serverKey: string, skillUri: string, fileUri: string): SkillOrigin | undefined {
    return this.entries.get(cacheKey(serverKey, skillUri, fileUri))?.origin;
  }
}

interface DiskMeta {
  readonly origin: SkillOrigin;
  readonly uri: string;
  readonly size: number;
  readonly sha256: string;
}

export class DiskSkillCache implements SkillCache {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    this.ensureDir();
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true });
    const marker = join(this.dir, SKILL_CACHE_EXCLUDE_MARKER);
    if (!existsSync(marker)) {
      writeFileSync(marker, "MCP skill cache - excluded from filesystem skill discovery\n", "utf8");
    }
  }

  get(serverKey: string, skillUri: string, fileUri: string, expectedSize: number, expectedSha256: string): SkillCacheEntry | undefined {
    const key = cacheKey(serverKey, skillUri, fileUri);
    const metaPath = join(this.dir, `${key}.meta.json`);
    const binPath = join(this.dir, `${key}.bin`);
    if (!existsSync(metaPath) || !existsSync(binPath)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as DiskMeta;
      const bytes = new Uint8Array(readFileSync(binPath));
      if (
        meta.origin?.kind !== "mcp" ||
        meta.origin.serverKey !== serverKey ||
        meta.origin.skillUri !== skillUri ||
        meta.uri !== fileUri ||
        meta.size !== expectedSize ||
        meta.sha256 !== expectedSha256 ||
        bytes.byteLength !== expectedSize ||
        sha256Hex(bytes) !== expectedSha256
      ) {
        return undefined;
      }
      return { origin: meta.origin, uri: meta.uri, size: meta.size, sha256: meta.sha256, bytes };
    } catch {
      return undefined;
    }
  }

  set(entry: SkillCacheEntry): void {
    this.ensureDir();
    const key = cacheKey(entry.origin.serverKey, entry.origin.skillUri, entry.uri);
    const meta: DiskMeta = {
      origin: { kind: "mcp", serverKey: entry.origin.serverKey, skillUri: entry.origin.skillUri },
      uri: entry.uri,
      size: entry.size,
      sha256: entry.sha256,
    };
    writeFileSync(join(this.dir, `${key}.meta.json`), JSON.stringify(meta), "utf8");
    writeFileSync(join(this.dir, `${key}.bin`), entry.bytes);
  }

  getOrigin(serverKey: string, skillUri: string, fileUri: string): SkillOrigin | undefined {
    const key = cacheKey(serverKey, skillUri, fileUri);
    const metaPath = join(this.dir, `${key}.meta.json`);
    if (!existsSync(metaPath)) return undefined;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as DiskMeta;
      return meta.origin?.kind === "mcp" ? meta.origin : undefined;
    } catch {
      return undefined;
    }
  }
}
