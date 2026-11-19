import type { McpClient, Outcome, OutcomeMeta } from "@mcp-client/core";
import type { SkillCache } from "./cache.js";
import { SKILLS_EXTENSION_ID, SKILLS_PIN } from "./extension.js";
import {
  isSkillMdUri,
  manifestFingerprint,
  validateSkillEntry,
  verifyFileBytes,
  verifySkillMd,
  type SkillEntry,
  type SkillFileEntry,
} from "./verify.js";

export interface SkillLoadApprovalRequest {
  readonly serverKey: string;
  readonly skillUri: string;
  readonly manifestFingerprint: string;
  readonly files: readonly SkillFileEntry[];
}

export interface SkillToolsApprovalRequest {
  readonly serverKey: string;
  readonly skillUri: string;
  readonly allowedTools: readonly string[];
  readonly nestedSkillUri?: string;
}

export interface SkillCrossServerReadRequest {
  readonly skillServer: string;
  readonly resourceServer: string;
  readonly skillUri: string;
  readonly resourceUri: string;
}

export interface SkillApprovalPort {
  approveLoad(req: SkillLoadApprovalRequest): Promise<boolean>;
  approveTools?(req: SkillToolsApprovalRequest): Promise<boolean>;
  approveCrossServerRead?(req: SkillCrossServerReadRequest): Promise<boolean>;
}

export interface SkillsClientOptions {
  readonly client: McpClient;
  readonly capabilities?: Record<string, unknown>;
  readonly approval?: SkillApprovalPort;
  readonly cache?: SkillCache;
  readonly allowDynamic?: boolean;
  readonly serverKey?: string;
}

export interface SkillsListResult {
  readonly skills: readonly SkillEntry[];
  readonly nextCursor?: string;
  readonly resultType: "complete";
  readonly ttlMs?: number;
  readonly cacheScope?: string;
}

export interface SkillGetResult {
  readonly skill: SkillEntry;
  readonly resultType: "complete";
  readonly ttlMs?: number;
  readonly cacheScope?: string;
}

export interface SkillReadFileResult {
  readonly file: SkillFileEntry;
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly fromCache: boolean;
}

function syntheticMeta(method: string): OutcomeMeta {
  return { requestId: 0, method, binding: "local", attempts: 0 };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

export class SkillsClient {
  private readonly client: McpClient;
  private readonly serverKey: string;
  private readonly caps: Record<string, unknown> | undefined;
  private readonly approval: SkillApprovalPort | undefined;
  private readonly cache: SkillCache | undefined;
  private readonly allowDynamic: boolean;
  private readonly entries = new Map<string, SkillEntry>();
  private readonly approvedFingerprints = new Map<string, string>();

  constructor(opts: SkillsClientOptions) {
    this.client = opts.client;
    this.serverKey = opts.serverKey ?? opts.client.server.key;
    this.caps = opts.capabilities;
    this.approval = opts.approval;
    this.cache = opts.cache;
    this.allowDynamic = opts.allowDynamic === true;
  }

  private entryKey(skillUri: string): string {
    return `${this.serverKey}\0${skillUri}`;
  }

  private checkCapabilities(): { readonly ok: true; readonly directoryRead: boolean } | { readonly ok: false; readonly reason: string } {
    if (!this.caps) return { ok: false, reason: "server capabilities missing" };
    if (!isObj(this.caps["resources"])) return { ok: false, reason: "server resources capability absent" };
    const exts = this.caps["extensions"];
    if (!isObj(exts)) return { ok: false, reason: "server extensions capability absent" };
    const ext = exts[SKILLS_EXTENSION_ID];
    if (!isObj(ext)) return { ok: false, reason: "server skills extension capability absent" };
    if (ext["revision"] !== undefined && ext["revision"] !== SKILLS_PIN.date) {
      return { ok: false, reason: `unknown skills revision: ${String(ext["revision"])}` };
    }
    return { ok: true, directoryRead: ext["directoryRead"] === true };
  }

  isKnownSkill(skillUri: string): boolean {
    return this.entries.has(this.entryKey(skillUri));
  }

  getRetainedSkill(skillUri: string): SkillEntry | undefined {
    return this.entries.get(this.entryKey(skillUri));
  }

  listRetainedSkills(): readonly SkillEntry[] {
    return Array.from(this.entries.values());
  }

  private retainEntry(entry: SkillEntry): void {
    const key = this.entryKey(entry.uri);
    const prev = this.entries.get(key);
    if (prev && manifestFingerprint(prev.files) !== manifestFingerprint(entry.files)) {
      this.approvedFingerprints.delete(key);
    }
    this.entries.set(key, entry);
  }

  async list(cursor?: string): Promise<Outcome<SkillsListResult>> {
    const cap = this.checkCapabilities();
    if (!cap.ok) {
      return { kind: "capability-absent", detail: cap.reason, meta: syntheticMeta("skills/list") };
    }
    const out = await this.client.request<Record<string, unknown>>("skills/list", cursor ? { cursor } : {});
    if (out.kind !== "ok") return out as Outcome<SkillsListResult>;
    const res = out.value;
    if (!Array.isArray(res["skills"])) {
      return { kind: "protocol-violation", detail: "skills/list missing skills array", meta: out.meta };
    }
    const skills: SkillEntry[] = [];
    for (const raw of res["skills"]) {
      const v = validateSkillEntry(raw, { allowDynamic: this.allowDynamic });
      if (!v.ok) {
        return { kind: v.kind === "limit-exceeded" ? "limit-exceeded" : "protocol-violation", detail: v.reason, meta: out.meta };
      }
      this.retainEntry(v.entry);
      skills.push(v.entry);
    }
    return {
      kind: "ok",
      value: {
        skills,
        ...(typeof res["nextCursor"] === "string" ? { nextCursor: res["nextCursor"] } : {}),
        resultType: "complete",
        ...(typeof res["ttlMs"] === "number" ? { ttlMs: res["ttlMs"] } : {}),
        ...(typeof res["cacheScope"] === "string" ? { cacheScope: res["cacheScope"] } : {}),
      },
      meta: out.meta,
    };
  }

  async listAll(): Promise<Outcome<SkillsListResult>> {
    const all: SkillEntry[] = [];
    let cursor: string | undefined;
    let lastMeta = syntheticMeta("skills/list");
    let ttlMs: number | undefined;
    let cacheScope: string | undefined;
    do {
      const page = await this.list(cursor);
      if (page.kind !== "ok") return page;
      lastMeta = page.meta;
      ttlMs = page.value.ttlMs;
      cacheScope = page.value.cacheScope;
      all.push(...page.value.skills);
      cursor = page.value.nextCursor;
    } while (cursor);
    return {
      kind: "ok",
      value: {
        skills: all,
        resultType: "complete",
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(cacheScope !== undefined ? { cacheScope } : {}),
      },
      meta: lastMeta,
    };
  }

  async get(uri: string): Promise<Outcome<SkillGetResult>> {
    const cap = this.checkCapabilities();
    if (!cap.ok) {
      return { kind: "capability-absent", detail: cap.reason, meta: syntheticMeta("skills/get") };
    }
    const out = await this.client.request<Record<string, unknown>>("skills/get", { uri });
    if (out.kind !== "ok") return out as Outcome<SkillGetResult>;
    const res = out.value;
    const rawSkill = res["skill"] ?? res;
    const v = validateSkillEntry(rawSkill, { allowDynamic: this.allowDynamic });
    if (!v.ok) {
      return { kind: v.kind === "limit-exceeded" ? "limit-exceeded" : "protocol-violation", detail: v.reason, meta: out.meta };
    }
    this.retainEntry(v.entry);
    return {
      kind: "ok",
      value: {
        skill: v.entry,
        resultType: "complete",
        ...(typeof res["ttlMs"] === "number" ? { ttlMs: res["ttlMs"] } : {}),
        ...(typeof res["cacheScope"] === "string" ? { cacheScope: res["cacheScope"] } : {}),
      },
      meta: out.meta,
    };
  }

  async approve(skillUri: string): Promise<boolean> {
    const entry = this.entries.get(this.entryKey(skillUri));
    if (!entry || !this.approval) return false;
    const fp = manifestFingerprint(entry.files);
    const ok = await this.approval.approveLoad({
      serverKey: this.serverKey,
      skillUri,
      manifestFingerprint: fp,
      files: entry.files,
    });
    if (!ok) return false;
    if (entry.allowedTools && entry.allowedTools.length > 0) {
      if (!this.approval.approveTools) return false;
      const toolsOk = await this.approval.approveTools({
        serverKey: this.serverKey,
        skillUri,
        allowedTools: entry.allowedTools,
      });
      if (!toolsOk) return false;
    }
    this.approvedFingerprints.set(this.entryKey(skillUri), fp);
    return true;
  }

  async activateNestedSkill(parentSkillUri: string, nestedSkillUri: string): Promise<boolean> {
    const entry = this.entries.get(this.entryKey(parentSkillUri));
    if (!entry || !this.approval?.approveTools) return false;
    return this.approval.approveTools({
      serverKey: this.serverKey,
      skillUri: parentSkillUri,
      allowedTools: entry.allowedTools ?? [],
      nestedSkillUri,
    });
  }

  async readFile(
    skillUri: string,
    fileUri: string,
    opts?: { readonly resourceServer?: string; readonly resourceClient?: McpClient },
  ): Promise<Outcome<SkillReadFileResult>> {
    const meta = syntheticMeta("resources/read");
    const entry = this.entries.get(this.entryKey(skillUri));
    if (!entry) {
      return { kind: "protocol-violation", detail: `unknown skill uri: ${skillUri}`, meta };
    }
    const fileEntry = entry.files.find((f) => f.uri === fileUri);
    if (!fileEntry) {
      return { kind: "protocol-violation", detail: `file uri not in retained manifest: ${fileUri}`, meta };
    }
    if (this.approval) {
      const approvedFp = this.approvedFingerprints.get(this.entryKey(skillUri));
      if (!approvedFp || approvedFp !== manifestFingerprint(entry.files)) {
        this.approvedFingerprints.delete(this.entryKey(skillUri));
        return { kind: "protocol-violation", detail: `skill not approved for current manifest: ${skillUri}`, meta };
      }
    }
    if (opts?.resourceServer && opts.resourceServer !== this.serverKey) {
      if (!this.approval?.approveCrossServerRead) {
        return { kind: "protocol-violation", detail: "cross-server read requires approval port", meta };
      }
      const allowed = await this.approval.approveCrossServerRead({
        skillServer: this.serverKey,
        resourceServer: opts.resourceServer,
        skillUri,
        resourceUri: fileUri,
      });
      if (!allowed) {
        return { kind: "protocol-violation", detail: "cross-server read denied", meta };
      }
    }
    const cached = this.cache?.get(this.serverKey, skillUri, fileUri, fileEntry.size, fileEntry.sha256);
    if (cached) {
      const text = Buffer.from(cached.bytes).toString("utf8");
      if (isSkillMdUri(fileUri)) {
        const mdCheck = verifySkillMd(fileUri, text, entry);
        if (!mdCheck.ok) {
          await this.get(skillUri);
          return { kind: "protocol-violation", detail: mdCheck.reason, meta };
        }
      }
      return { kind: "ok", value: { file: fileEntry, bytes: cached.bytes, text, fromCache: true }, meta };
    }
    const reader = opts?.resourceClient ?? this.client;
    const out = await reader.request<Record<string, unknown>>("resources/read", { uri: fileUri });
    if (out.kind !== "ok") return out as Outcome<SkillReadFileResult>;
    const contents = out.value["contents"];
    if (!Array.isArray(contents) || contents.length === 0 || !isObj(contents[0])) {
      await this.get(skillUri);
      return { kind: "protocol-violation", detail: "resources/read missing contents", meta: out.meta };
    }
    const item = contents[0];
    const bytes =
      typeof item["blob"] === "string"
        ? new Uint8Array(Buffer.from(item["blob"], "base64"))
        : typeof item["text"] === "string"
          ? new Uint8Array(Buffer.from(item["text"], "utf8"))
          : undefined;
    if (!bytes) {
      await this.get(skillUri);
      return { kind: "protocol-violation", detail: "resources/read missing text or blob", meta: out.meta };
    }
    const byteCheck = verifyFileBytes(bytes, fileEntry);
    if (!byteCheck.ok) {
      await this.get(skillUri);
      return { kind: "protocol-violation", detail: byteCheck.reason, meta: out.meta };
    }
    const text = Buffer.from(bytes).toString("utf8");
    if (isSkillMdUri(fileUri)) {
      const mdCheck = verifySkillMd(fileUri, text, entry);
      if (!mdCheck.ok) {
        await this.get(skillUri);
        return { kind: "protocol-violation", detail: mdCheck.reason, meta: out.meta };
      }
    }
    this.cache?.set({
      origin: { kind: "mcp", serverKey: this.serverKey, skillUri },
      uri: fileUri,
      size: fileEntry.size,
      sha256: fileEntry.sha256,
      bytes,
    });
    return { kind: "ok", value: { file: fileEntry, bytes, text, fromCache: false }, meta: out.meta };
  }

  async readDirectory(skillUri: string, dirUri: string): Promise<Outcome<{ readonly uris: readonly string[] }>> {
    const cap = this.checkCapabilities();
    if (!cap.ok || !cap.directoryRead) {
      return { kind: "capability-absent", detail: "directoryRead capability absent", meta: syntheticMeta("resources/directory/read") };
    }
    const entry = this.entries.get(this.entryKey(skillUri));
    if (!entry) {
      return { kind: "protocol-violation", detail: `unknown skill uri: ${skillUri}`, meta: syntheticMeta("resources/directory/read") };
    }
    const out = await this.client.request<Record<string, unknown>>("resources/directory/read", { uri: dirUri });
    if (out.kind !== "ok") return out as Outcome<{ readonly uris: readonly string[] }>;
    const rawUris = Array.isArray(out.value["uris"])
      ? out.value["uris"].filter((u): u is string => typeof u === "string")
      : Array.isArray(out.value["entries"])
        ? out.value["entries"]
            .map((e) => (isObj(e) && typeof e["uri"] === "string" ? e["uri"] : undefined))
            .filter((u): u is string => Boolean(u))
        : [];
    const manifestUris = new Set(entry.files.map((f) => f.uri));
    return { kind: "ok", value: { uris: rawUris.filter((u) => manifestUris.has(u)) }, meta: out.meta };
  }
}
