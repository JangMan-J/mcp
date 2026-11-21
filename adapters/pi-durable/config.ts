import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolve as resolvePath } from "node:path";
// Legacy Pi `mcpServers` reader. PICA-3: untrusted project never enables a server. PICA-11: pure/read-only, rollback stays one edit.
export type LegacySource = "project" | "global" | "dynamic";
export type Exposure = "codemode" | "deferred" | "direct" | "hidden";
export interface ReadOptions { source?: LegacySource; trusted?: boolean; trust?: boolean; } // trust: alias
export interface LegacyServerConfig {
  readonly allowLegacyInitialize?: boolean; readonly inheritEnv?: boolean | readonly string[];
  readonly name: string; readonly source: LegacySource; readonly trusted: boolean;
  readonly transport: "stdio" | "http"; readonly enabled: boolean; readonly exposure: Exposure;
  readonly command?: string; readonly args?: readonly string[]; readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>; readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>; readonly description?: string;
  readonly timeout?: number; readonly timeoutMs?: number; readonly aliases?: readonly string[];
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  readonly subscribe?: readonly LegacySubscriptionConfig[];
  readonly oauth?: LegacyOAuthConfig;
  readonly auth?: LegacyAuthConfig;
  readonly clientCredentials?: Readonly<Record<string, unknown>>;
  readonly enterpriseAuth?: Readonly<Record<string, unknown>>;
}
export interface LegacySubscriptionConfig {
  readonly name: string;
  readonly delivery?: "auto" | "push" | "poll";
  readonly holdSettle?: boolean;
  readonly arguments?: Record<string, unknown>;
  readonly maxAgeMs?: number;
}
export interface LegacyOAuthConfig {
  readonly clientId?: string; readonly clientSecret?: string; readonly callbackPort?: number;
  readonly callbackUrl?: string; readonly scope?: string; readonly clientName?: string;
  readonly clientRegistration?: "auto" | "dcr" | "cimd"; readonly authServerMetadataUrl?: string;
  readonly [key: string]: unknown;
}
export interface LegacyAuthConfig { readonly provider: string; }
type Rec = Record<string, unknown>; const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
function bad(m: string): never { throw new TypeError(`readLegacyConfig: ${m}`); }
function strMap(v: unknown, field: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isRec(v) || Object.values(v).some((x) => typeof x !== "string")) bad(`${field} must be a string map`);
  return { ...(v as Record<string, string>) };
}
function exposure(v: unknown, field = "exposure"): Exposure {
  if (v === undefined) return "direct";
  if (v === "codemode-deferred") return "codemode"; // legacy alias (cutover table)
  if (v === "codemode" || v === "deferred" || v === "direct" || v === "hidden") return v;
  return bad(`${field} is invalid`);
}
function optStr(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v === "") bad(`${field} must be a non-empty string`);
  return v;
}
function positiveMs(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) bad(`${field} must be finite and positive`);
  return v;
}
function parseSubscriptions(raw: unknown, field: string): LegacySubscriptionConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) bad(`${field} must be an array`);
  return Array.from(raw, (item: unknown, i) => {
    const p = `${field}[${i}]`;
    if (!isRec(item)) bad(`${p} must be an object`);
    const name = optStr(item.name, `${p}.name`);
    if (!name?.trim()) bad(`${p}.name must be a non-empty string`);
    const { delivery, holdSettle, arguments: args } = item;
    if (delivery !== undefined && delivery !== "auto" && delivery !== "push" && delivery !== "poll")
      bad(`${p}.delivery must be auto, push, or poll`);
    if (holdSettle !== undefined && typeof holdSettle !== "boolean") bad(`${p}.holdSettle must be boolean`);
    if (args !== undefined && !isRec(args)) bad(`${p}.arguments must be an object`);
    const maxAgeMs = positiveMs(item.maxAgeMs, `${p}.maxAgeMs`);
    return { name, ...(delivery !== undefined && { delivery }), ...(holdSettle !== undefined && { holdSettle }),
      ...(args !== undefined && { arguments: { ...args } }), ...(maxAgeMs !== undefined && { maxAgeMs }) };
  });
}
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
function requireGlobalAuth(field: string, source: LegacySource, url: string | undefined, trusted: boolean): void {
  if (source !== "global" || !trusted) bad(`${field} is only allowed in the global mcp.json`);
  if (!url) bad(`${field} requires an HTTP server`);
  const u = new URL(url);
  if (!(u.protocol === "https:" || LOOPBACK.has(u.hostname))) bad(`${field} requires an https: or loopback http: url`);
}
function authBlock(v: unknown, field: string, source: LegacySource, url: string | undefined, trusted: boolean): Rec | undefined {
  if (v === undefined) return undefined;
  requireGlobalAuth(field, source, url, trusted);
  if (!isRec(v) || (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null))
    bad(`${field} must be an object`);
  for (const k of ["secret", "clientSecret"]) {
    if (v[k] !== undefined && typeof v[k] !== "string") bad(`${field}.${k} must be a string`);
  }
  return { ...v };
}
function parseUrl(v: string): URL | undefined { try { return new URL(v); } catch { return undefined; } }
function validateOAuth(name: string, o: Rec): LegacyOAuthConfig {
  const p = `server "${name}" oauth`;
  for (const k of ["clientId", "clientSecret", "callbackUrl", "scope", "clientName", "authServerMetadataUrl"] as const)
    if (o[k] !== undefined && typeof o[k] !== "string") bad(`${p}.${k} must be a string`);
  const port = o.callbackPort;
  if (port !== undefined && !(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535))
    bad(`${p}.callbackPort must be an integer 1..65535`);
  let cb: URL | undefined;
  if (typeof o.callbackUrl === "string") {
    cb = parseUrl(o.callbackUrl);
    if (!cb || cb.protocol !== "http:" || !LOOPBACK.has(cb.hostname) || cb.search !== "" || cb.hash !== "")
      bad(`${p}.callbackUrl must be an http: loopback URL without query or fragment`);
    if (port !== undefined && cb.port !== "" && Number(cb.port) !== port) bad(`${p}.callbackUrl port must match callbackPort`);
  }
  if (typeof o.clientName === "string" && o.clientName.trim().length === 0) bad(`${p}.clientName must be non-empty`);
  const reg = o.clientRegistration;
  if (reg !== undefined && reg !== "auto" && reg !== "dcr" && reg !== "cimd") bad(`${p}.clientRegistration must be auto, dcr, or cimd`);
  if (reg === "cimd") {
    if (o.clientId !== undefined || o.clientName !== undefined) bad(`${p}: cimd registration does not allow clientId or clientName`);
    if (cb && ((cb.hostname !== "localhost" && cb.hostname !== "127.0.0.1") || cb.pathname !== "/callback"))
      bad(`${p}: cimd callbackUrl must be http://localhost or 127.0.0.1 with path /callback`);
  }
  if (typeof o.authServerMetadataUrl === "string") {
    const u = parseUrl(o.authServerMetadataUrl);
    if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))))
      bad(`${p}.authServerMetadataUrl must be https: or http: loopback`);
  }
  return { ...o } as LegacyOAuthConfig;
}
function parseServer(name: string, raw: unknown, source: LegacySource, trusted: boolean): LegacyServerConfig {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) bad(`invalid server name "${name}"`);
    if (!isRec(raw)) bad(`server "${name}" must be an object`);
    if (raw.type === "sse") bad(`server "${name}": legacy SSE transport is not supported; use the streamable HTTP URL`);
    const http = raw.url !== undefined || raw.type === "http" || raw.type === "streamable-http";
    if (raw.type !== undefined && raw.type !== "stdio" && raw.type !== "http" && raw.type !== "streamable-http")
      bad(`server "${name}": unsupported type`);
    if (http && raw.command !== undefined) bad(`server "${name}": use either command or url`);
    let url: string | undefined;
    if (http) {
      url = optStr(raw.url, `server "${name}" url`);
      if (!url) bad(`server "${name}": url is required for HTTP`);
      try { const u = new URL(url); if (u.protocol !== "http:" && u.protocol !== "https:") throw 0; }
      catch { bad(`server "${name}": url must be http: or https:`); }
    }
    const command = http ? undefined : optStr(raw.command, `server "${name}" command`);
    if (!http && !command) bad(`server "${name}": command is required for stdio`);
    if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some((a) => typeof a !== "string")))
      bad(`server "${name}": args must be string[]`);
    if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") bad(`server "${name}": enabled must be boolean`);
    if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) bad(`server "${name}": timeout must be positive`);
    const timeoutMs = positiveMs(raw.timeoutMs, `server "${name}" timeoutMs`);
    if (raw.allowLegacyInitialize !== undefined && typeof raw.allowLegacyInitialize !== "boolean") bad("allowLegacyInitialize must be boolean");
    if (raw.inheritEnv !== undefined && typeof raw.inheritEnv !== "boolean" && (!Array.isArray(raw.inheritEnv) || raw.inheritEnv.some(k => typeof k !== "string"))) bad("inheritEnv must be boolean or string[]");
    const subscribe = parseSubscriptions(raw.subscribe, `server "${name}" subscribe`);
    if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some((a) => typeof a !== "string")))
      bad(`server "${name}": aliases must be string[]`);
    if (raw.oauth !== undefined && !isRec(raw.oauth)) bad(`server "${name}": oauth must be an object`);
    const oauth = isRec(raw.oauth) ? validateOAuth(name, raw.oauth) : undefined;
    let auth: LegacyAuthConfig | undefined;
    if (raw.auth !== undefined) {
      requireGlobalAuth(`server "${name}": auth`, source, url, trusted);
      if (!isRec(raw.auth) || typeof raw.auth.provider !== "string" || raw.auth.provider.length === 0)
        bad(`server "${name}": auth.provider must be a non-empty string`);
      auth = { provider: raw.auth.provider };
    }
    const clientCredentials = authBlock(raw.clientCredentials, `server "${name}" clientCredentials`, source, url, trusted);
    const enterpriseAuth = authBlock(raw.enterpriseAuth, `server "${name}" enterpriseAuth`, source, url, trusted);
    const toolExposure = raw.toolExposure === undefined ? undefined : Object.fromEntries(
      Object.entries(strMap(raw.toolExposure, `server "${name}" toolExposure`) ?? {}).map(([k, v]) => [k, exposure(v, "toolExposure")]));
    const env = strMap(raw.env, "env"); const headers = strMap(raw.headers, "headers");
    return {
      name, source, trusted, transport: http ? "http" as const : "stdio" as const,
      enabled: raw.enabled ?? true, exposure: exposure(raw.exposure),
      ...(raw.allowLegacyInitialize !== undefined ? { allowLegacyInitialize: raw.allowLegacyInitialize } : {}),
      ...(raw.inheritEnv !== undefined ? { inheritEnv: typeof raw.inheritEnv === "boolean" ? raw.inheritEnv : [...raw.inheritEnv as string[]] } : {}),
      ...(command ? { command } : {}), ...(url ? { url } : {}),
      ...(raw.args ? { args: [...raw.args as string[]] } : {}),
      ...(optStr(raw.cwd, "cwd") ? { cwd: raw.cwd as string } : {}),
      ...(env ? { env } : {}), ...(headers ? { headers } : {}),
      ...(optStr(raw.description, "description") ? { description: raw.description as string } : {}),
      ...(raw.timeout !== undefined ? { timeout: raw.timeout as number } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(subscribe ? { subscribe } : {}),
      ...(clientCredentials ? { clientCredentials } : {}), ...(enterpriseAuth ? { enterpriseAuth } : {}),
      ...(raw.aliases ? { aliases: [...raw.aliases as string[]] } : {}),
      ...(toolExposure ? { toolExposure } : {}),
      ...(oauth ? { oauth } : {}), ...(auth ? { auth } : {}),
    };
}
export function readLegacyConfig(input: unknown, opts: ReadOptions = {}): LegacyServerConfig[] {
  const source = opts.source ?? "global";
  const trusted = opts.trusted ?? opts.trust ?? source !== "project";
  if (source === "project" && !trusted) return []; // PICA-3: before inspecting input
  if (!isRec(input) || !isRec(input.mcpServers)) bad("expected { mcpServers: { ... } }");
  return Object.entries(input.mcpServers).map(([name, raw]) => parseServer(name, raw, source, trusted));
}

export interface VariableContext {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly disallowShellSubstitution?: boolean;
}
/** Pure `${NAME}` expansion in env, headers and auth secrets; `!cmd` is never executed. */
export function resolveServerVariables(config: LegacyServerConfig, ctx: VariableContext): LegacyServerConfig {
  const sub = (v: string): string => {
    if (v.startsWith("!")) {
      if (ctx.disallowShellSubstitution) throw new TypeError(`resolveServerVariables: shell substitution is disallowed in server "${config.name}"`);
      return v;
    }
    return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n: string) => ctx.env?.[n] ?? "");
  };
  const map = (m: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(v)]));
  const secrets = (block: Readonly<Rec>): Rec => {
    const copy = { ...block };
    for (const k of ["secret", "clientSecret"]) {
      if (typeof copy[k] === "string") copy[k] = sub(copy[k]);
    }
    return copy;
  };
  return {
    ...config,
    ...(config.env ? { env: map(config.env) } : {}),
    ...(config.headers ? { headers: map(config.headers) } : {}),
    ...(typeof config.oauth?.clientSecret === "string" ? { oauth: { ...config.oauth, clientSecret: sub(config.oauth.clientSecret) } } : {}),
    ...(config.clientCredentials ? { clientCredentials: secrets(config.clientCredentials) } : {}),
    ...(config.enterpriseAuth ? { enterpriseAuth: secrets(config.enterpriseAuth) } : {}),
    ...(config.cwd !== undefined && ctx.cwd !== undefined ? { cwd: resolvePath(ctx.cwd, config.cwd) } : {}),
  };
}

export type ServerDescriptor = LegacyServerConfig;

export function normalizeServer(name: string, raw: unknown): ServerDescriptor {
  return resolveServerVariables(parseServer(name, raw, "global", true), { env: process.env, disallowShellSubstitution: true });
}

/** Only operator-selected config files are read. Never execute shell substitutions. */
export async function loadServers(configPath: string): Promise<ServerDescriptor[]> {
  const input: unknown = JSON.parse(await readFile(configPath, "utf8"));
  return readLegacyConfig(input).filter(server => server.enabled).map(server => resolveServerVariables(server, {
    env: process.env, cwd: dirname(configPath), disallowShellSubstitution: true,
  }));
}
