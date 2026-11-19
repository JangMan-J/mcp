import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  McpClient,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportCall,
  type TransportDiagnostic,
} from "@mcp-client/core";
import { createOps } from "@mcp-client/ops";
import { DiskSkillCache, SkillsClient, createSkillsExtension, sha256Hex, type SkillApprovalPort } from "./index.js";

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const MUTANTS = new Set([
  "call-without-resources", "split-manifest-across-pages", "drop-cache-fields", "retry-on-32602",
  "replace-by-name", "trust-scheme-alone", "prefetch-on-list",
  "skip-digest-check", "skip-frontmatter-check", "return-on-mismatch-no-refresh",
  "keep-approval-on-digest-change", "allow-cross-server-without-approval", "ignore-cache-tamper",
  "allow-dynamic-by-default", "allow-over-512-files", "call-directory-read-without-flag", "include-unlisted-directory-files",
  "advertise-when-unhealthy", "alter-resources-list",
]);

export const supportsMutant = (name: string): boolean => MUTANTS.has(name);

type Json = Record<string, unknown>;
const bad = (m: string): never => { throw new Error(`malformed fixture: ${m}`); };
const mismatch = (m: string): never => { throw new ObservationMismatch(m); };
const eq = (a: unknown, e: unknown, label: string) => {
  if (!isDeepStrictEqual(a, e)) mismatch(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
};

class ScriptTransport implements Transport {
  readonly binding = "stdio" as const;
  readonly sent: JsonRpcRequest[] = [];
  readonly diagnostics: AsyncIterable<TransportDiagnostic> = { async *[Symbol.asyncIterator]() {} };
  private readonly queue: Array<{ forCall?: string; result?: Json; error?: { code: number; message: string; data?: unknown } }> = [];
  private activeCall: string | undefined;

  pushReply(reply: { forCall?: string; result?: Json; error?: { code: number; message: string; data?: unknown } }): void {
    this.queue.push(reply);
  }
  setActiveCall(as: string): void { this.activeCall = as; }

  start(msg: JsonRpcRequest, _ctx: TransportCall): Exchange {
    this.sent.push(msg);
    const idx = this.queue.findIndex((r) => !r.forCall || r.forCall === this.activeCall);
    const reply = idx >= 0 ? this.queue.splice(idx, 1)[0] : undefined;
    const notifications: AsyncIterable<JsonRpcNotification> = { async *[Symbol.asyncIterator]() {} };
    const done: Promise<ExchangeEnd> = Promise.resolve(
      reply?.error
        ? { kind: "response", message: { jsonrpc: "2.0", id: msg.id, error: reply.error } }
        : { kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: reply?.result ?? {} } },
    );
    return { notifications, done };
  }
  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

export async function runExchange(fixture: unknown, mutant?: string): Promise<void> {
  if (mutant !== undefined && !MUTANTS.has(mutant)) throw new Error(`unknown mutant: ${mutant}`);
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) bad("fixture must be object");
  const fx = fixture as Json;
  const script = Array.isArray(fx["script"]) ? (fx["script"] as Json[]) : bad("script");
  const expectObj = (fx["expect"] as Json | undefined) ?? {};
  const serverCfg = (fx["server"] as Json | undefined) ?? {};
  const serverCaps = (serverCfg["capabilities"] as Json | undefined) ?? {};
  const clientCfg = (fx["client"] as Json | undefined) ?? {};
  const setup = (clientCfg["setup"] as Json | undefined) ?? {};

  const transport = new ScriptTransport();
  const mcpClient = new McpClient({ transport, server: { key: "server-a" } });
  const otherTransport = new ScriptTransport();
  const otherClient = new McpClient({ transport: otherTransport, server: { key: "server-b" } });

  const approvedSet = new Set<string>();
  const crossServerCalls: Array<{ skillServer: string; resourceServer: string }> = [];
  const approvalPort: SkillApprovalPort | undefined = setup["useApproval"] === true
    ? {
        async approveLoad(req) {
          approvedSet.add(`${req.skillUri}:${req.manifestFingerprint}`);
          return setup["denyLoad"] !== true;
        },
        async approveTools() { return setup["denyTools"] !== true; },
        async approveCrossServerRead(req) {
          crossServerCalls.push({ skillServer: req.skillServer, resourceServer: req.resourceServer });
          return setup["allowCrossServer"] === true;
        },
      }
    : undefined;

  const tmpDir = setup["useDiskCache"] === true ? mkdtempSync(join(tmpdir(), "ext-skills-conf-")) : undefined;
  try {
    const cache = tmpDir ? new DiskSkillCache(tmpDir) : undefined;
    let skillsClient = new SkillsClient({
      client: mcpClient,
      capabilities: serverCaps,
      ...(approvalPort ? { approval: approvalPort } : {}),
      ...(cache ? { cache } : {}),
      allowDynamic: setup["allowDynamic"] === true,
    });

    for (const s of script) {
      if (s["server"] === "result" || s["server"] === "error") {
        const reply: { forCall?: string; result?: Json; error?: { code: number; message: string; data?: unknown } } = {};
        if (typeof s["for"] === "string") reply.forCall = s["for"];
        if (s["server"] === "result") reply.result = (s["result"] as Json) ?? {};
        else reply.error = s["error"] as { code: number; message: string; data?: unknown };
        (s["serverKey"] === "server-b" ? otherTransport : transport).pushReply(reply);
      }
    }

    const outcomes: Record<string, Json> = {};
    for (const s of script) {
      if (s["do"] !== "call") continue;
      const as = String(s["as"] ?? bad("as"));
      const method = String(s["method"] ?? bad("method"));
      const params = (s["params"] as Json | undefined) ?? {};
      transport.setActiveCall(as);
      otherTransport.setActiveCall(as);

      if (method === "skills/list") {
        const target = params["overrideCaps"]
          ? new SkillsClient({ client: mcpClient, capabilities: params["overrideCaps"] as Json, allowDynamic: setup["allowDynamic"] === true })
          : skillsClient;
        if (mutant === "call-without-resources") await mcpClient.request("skills/list", {});
        const out = await target.list(typeof params["cursor"] === "string" ? params["cursor"] : undefined);
        if (mutant === "prefetch-on-list" && out.kind === "ok") await mcpClient.request("resources/read", { uri: "skill://s/SKILL.md" });
        if (mutant === "split-manifest-across-pages" && out.kind === "protocol-violation") {
          outcomes[as] = { kind: "ok" }; continue;
        }
        if (mutant === "drop-cache-fields" && out.kind === "ok") {
          outcomes[as] = { kind: "ok", resultType: undefined, ttlMs: undefined, cacheScope: undefined }; continue;
        }
        if (mutant === "allow-dynamic-by-default" && out.kind === "protocol-violation") {
          outcomes[as] = { kind: "ok" }; continue;
        }
        if (mutant === "allow-over-512-files" && out.kind === "limit-exceeded") {
          outcomes[as] = { kind: "ok" }; continue;
        }
        outcomes[as] = out.kind === "ok"
          ? { kind: "ok", count: out.value.skills.length, resultType: out.value.resultType, ttlMs: out.value.ttlMs, cacheScope: out.value.cacheScope }
          : { kind: out.kind };
      } else if (method === "skills/get") {
        const out = await skillsClient.get(String(params["uri"]));
        if (mutant === "retry-on-32602" && out.kind === "jsonrpc-error") await mcpClient.request("skills/get", { uri: params["uri"] });
        outcomes[as] = out.kind === "ok"
          ? { kind: "ok", uri: out.value.skill.uri, resultType: out.value.resultType, ttlMs: out.value.ttlMs, cacheScope: out.value.cacheScope }
          : { kind: out.kind, ...(out.kind === "jsonrpc-error" ? { code: out.code } : {}) };
      } else if (method === "skills/approve") {
        const ok = await skillsClient.approve(String(params["uri"]));
        outcomes[as] = { approved: ok };
      } else if (method === "skills/readFile") {
        const rs = typeof params["resourceServer"] === "string" ? params["resourceServer"] : undefined;
        const out = await skillsClient.readFile(String(params["skillUri"]), String(params["fileUri"]), {
          ...(rs ? { resourceServer: rs, resourceClient: otherClient } : {}),
        });
        if (mutant === "skip-digest-check" && out.kind === "protocol-violation") { outcomes[as] = { kind: "ok" }; continue; }
        if (mutant === "skip-frontmatter-check" && out.kind === "protocol-violation") { outcomes[as] = { kind: "ok" }; continue; }
        if (mutant === "return-on-mismatch-no-refresh" && out.kind === "protocol-violation") { outcomes[as] = { kind: "ok" }; continue; }
        if (mutant === "keep-approval-on-digest-change" && out.kind === "protocol-violation") { outcomes[as] = { kind: "ok" }; continue; }
        if (mutant === "allow-cross-server-without-approval" && out.kind === "protocol-violation") { outcomes[as] = { kind: "ok" }; continue; }
        outcomes[as] = out.kind === "ok" ? { kind: "ok", text: out.value.text, fromCache: out.value.fromCache } : { kind: out.kind };
      } else if (method === "skills/readDirectory") {
        if (mutant === "call-directory-read-without-flag") await mcpClient.request("resources/directory/read", { uri: params["dirUri"] });
        const target = params["overrideCaps"]
          ? new SkillsClient({ client: mcpClient, capabilities: params["overrideCaps"] as Json })
          : skillsClient;
        const out = await target.readDirectory(String(params["skillUri"]), String(params["dirUri"]));
        if (mutant === "include-unlisted-directory-files" && out.kind === "ok") {
          outcomes[as] = { kind: "ok", uris: [...out.value.uris, "skill://server/s/extra.txt"] }; continue;
        }
        outcomes[as] = out.kind === "ok" ? { kind: "ok", uris: out.value.uris } : { kind: out.kind };
      } else if (method === "skills/isKnown") {
        outcomes[as] = { known: mutant === "trust-scheme-alone" ? true : skillsClient.isKnownSkill(String(params["uri"])) };
      } else if (method === "skills/retainedCount") {
        outcomes[as] = { count: mutant === "replace-by-name" ? 1 : skillsClient.listRetainedSkills().length };
      } else if (method === "skills/checkCaps") {
        const ext = createSkillsExtension({ healthy: params["healthy"] !== false });
        const caps = mutant === "advertise-when-unhealthy" ? { extensions: { [ext.id]: {} } } : ext.capabilities(params["isWorking"] !== false);
        outcomes[as] = { hasSkillsCap: Boolean((caps["extensions"] as Json | undefined)?.[ext.id]) };
      } else if (method === "resources/list") {
        const ops = createOps(mcpClient, { capabilities: serverCaps });
        const out = await ops.resources.list();
        outcomes[as] = out.kind === "ok"
          ? { kind: "ok", count: mutant === "alter-resources-list" ? 99 : out.value.items.length }
          : { kind: out.kind };
      } else if (method === "cache/tamperAndRead" && tmpDir) {
        const restarted = new DiskSkillCache(tmpDir);
        const origin = restarted.getOrigin("server-a", String(params["skillUri"]), String(params["fileUri"]));
        const keyHex = sha256Hex(Buffer.from(`server-a\0${String(params["skillUri"])}\0${String(params["fileUri"])}`, "utf8"));
        writeFileSync(join(tmpDir, `${keyHex}.bin`), "tampered-bytes", "utf8");
        const hit = restarted.get("server-a", String(params["skillUri"]), String(params["fileUri"]), Number(params["size"]), String(params["sha256"]));
        outcomes[as] = { originKind: origin?.kind, tamperedHit: mutant === "ignore-cache-tamper" ? true : Boolean(hit) };
      } else {
        bad(`unsupported method: ${method}`);
      }
    }

    const expectedOutcomes = (expectObj["outcome"] as Record<string, Json> | undefined) ?? {};
    for (const [k, exp] of Object.entries(expectedOutcomes)) {
      const actual = outcomes[k];
      if (!actual) return mismatch(`missing outcome for ${k}`);
      for (const [field, val] of Object.entries(exp)) eq(actual[field], val, `${k}.${field}`);
    }

    const wireExp = (expectObj["wire"] as Json | undefined) ?? {};
    if (typeof wireExp["totalRequests"] === "number") eq(transport.sent.length, wireExp["totalRequests"], "wire.totalRequests");
    if (Array.isArray(wireExp["never"])) {
      for (const m of wireExp["never"] as string[]) {
        if (transport.sent.some((r) => r.method === m)) mismatch(`wire.never violated: ${m}`);
      }
    }
    if (wireExp["count"] && typeof wireExp["count"] === "object") {
      for (const [m, c] of Object.entries(wireExp["count"] as Record<string, number>)) {
        eq(transport.sent.filter((r) => r.method === m).length, c, `wire.count.${m}`);
      }
    }
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}
