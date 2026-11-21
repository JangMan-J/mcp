import { resolve as resolvePath } from "node:path";
// Legacy Pi `mcpServers` reader. PICA-3: untrusted project never enables a server. PICA-11: pure/read-only, rollback stays one edit.
export type LegacySource = "project" | "global";
export type Exposure = "codemode" | "deferred" | "direct" | "hidden";
export interface ReadOptions { source?: LegacySource; trusted?: boolean; trust?: boolean; } // trust: alias
export interface LegacyServerConfig {
  readonly name: string; readonly source: LegacySource; readonly trusted: boolean;
  readonly transport: "stdio" | "http"; readonly enabled: boolean; readonly exposure: Exposure;
  readonly command?: string; readonly args?: readonly string[]; readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>; readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>; readonly description?: string;
  readonly timeout?: number; readonly aliases?: readonly string[];
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  readonly oauth?: LegacyOAuthConfig;
  readonly auth?: LegacyAuthConfig;
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
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
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
    if (raw.aliases !== undefined && (!Array.isArray(raw.aliases) || raw.aliases.some((a) => typeof a !== "string")))
      bad(`server "${name}": aliases must be string[]`);
    if (raw.oauth !== undefined && !isRec(raw.oauth)) bad(`server "${name}": oauth must be an object`);
    const oauth = isRec(raw.oauth) ? validateOAuth(name, raw.oauth) : undefined;
    let auth: LegacyAuthConfig | undefined;
    if (raw.auth !== undefined) {
      if (source === "project") bad(`server "${name}": auth is only allowed in the global mcp.json`);
      if (!http || !url) bad(`server "${name}": auth requires an HTTP server`);
      if (!isRec(raw.auth) || typeof raw.auth.provider !== "string" || raw.auth.provider.length === 0)
        bad(`server "${name}": auth.provider must be a non-empty string`);
      const u = new URL(url);
      if (!(u.protocol === "https:" || LOOPBACK.has(u.hostname))) bad(`server "${name}": auth requires an https: or loopback http: url`);
      auth = { provider: raw.auth.provider };
    }
    const toolExposure = raw.toolExposure === undefined ? undefined : Object.fromEntries(
      Object.entries(strMap(raw.toolExposure, `server "${name}" toolExposure`) ?? {}).map(([k, v]) => [k, exposure(v, "toolExposure")]));
    const env = strMap(raw.env, "env"); const headers = strMap(raw.headers, "headers");
    return {
      name, source, trusted, transport: http ? "http" as const : "stdio" as const,
      enabled: raw.enabled ?? true, exposure: exposure(raw.exposure),
      ...(command ? { command } : {}), ...(url ? { url } : {}),
      ...(raw.args ? { args: [...raw.args as string[]] } : {}),
      ...(optStr(raw.cwd, "cwd") ? { cwd: raw.cwd as string } : {}),
      ...(env ? { env } : {}), ...(headers ? { headers } : {}),
      ...(optStr(raw.description, "description") ? { description: raw.description as string } : {}),
      ...(raw.timeout !== undefined ? { timeout: raw.timeout as number } : {}),
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

/** Exact key wins, then `*` patterns in insertion order, then the server default. */
export function getToolExposure(config: Pick<LegacyServerConfig, "exposure" | "toolExposure">, toolName: string): Exposure {
  const map = config.toolExposure;
  if (!map) return config.exposure;
  if (Object.hasOwn(map, toolName)) return map[toolName] as Exposure;
  for (const [k, v] of Object.entries(map)) {
    if (!k.includes("*")) continue;
    const re = new RegExp(`^${k.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (re.test(toolName)) return v;
  }
  return config.exposure;
}

export function isServerOverride(raw: unknown): boolean {
  return isRec(raw) && raw.command === undefined && raw.url === undefined && raw.type === undefined;
}
export function mcpServerNamespace(name: string): string { return name.replace(/[^A-Za-z0-9_]/g, "_"); }

export interface LoadedLegacyMcpConfig {
  readonly servers: readonly LegacyServerConfig[];
  readonly autoEnableCodemode?: boolean;
  readonly errors: readonly string[];
}
const OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure"]);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export function loadLayeredMcpConfig(opts: { globalInput?: unknown; projectInput?: unknown; projectTrusted?: boolean }): LoadedLegacyMcpConfig {
  const errors: string[] = [];
  const servers = new Map<string, LegacyServerConfig>();
  let autoEnableCodemode: boolean | undefined;
  const layer = (input: unknown, source: LegacySource): void => {
    if (!isRec(input) || !isRec(input.mcpServers)) { errors.push(`${source}: expected { mcpServers: { ... } }`); return; }
    if (input.autoEnableCodemode !== undefined) {
      if (typeof input.autoEnableCodemode === "boolean") autoEnableCodemode = input.autoEnableCodemode;
      else errors.push(`${source}: autoEnableCodemode must be boolean`);
    }
    for (const [name, raw] of Object.entries(input.mcpServers)) {
      try {
        if (source === "project" && isServerOverride(raw)) {
          const base = servers.get(name);
          if (!base || base.source !== "global") { errors.push(`project: override "${name}" has no global server to override`); continue; }
          const extra = Object.keys(raw as Rec).filter((k) => !OVERRIDE_KEYS.has(k));
          if (extra.length) { errors.push(`project: override "${name}" may only set enabled, exposure, toolExposure (got ${extra.join(", ")})`); continue; }
          const o = raw as Rec;
          const probe = parseServer(name, { command: "x", ...o }, "project", true);
          servers.set(name, {
            ...base,
            ...(o.enabled !== undefined ? { enabled: probe.enabled } : {}),
            ...(o.exposure !== undefined ? { exposure: probe.exposure } : {}),
            ...(probe.toolExposure ? { toolExposure: probe.toolExposure } : {}),
          });
          continue;
        }
        const cfg = parseServer(name, raw, source, true);
        const ns = mcpServerNamespace(name);
        const clash = [...servers.keys()].find((n) => n !== name && mcpServerNamespace(n) === ns);
        if (clash) { errors.push(`${source}: server "${name}" collides with "${clash}" in namespace "${ns}"`); continue; }
        servers.set(name, cfg);
      } catch (e) { errors.push(`${source}: ${msg(e)}`); }
    }
  };
  if (opts.globalInput !== undefined) layer(opts.globalInput, "global");
  if (opts.projectInput !== undefined && opts.projectTrusted === true) layer(opts.projectInput, "project");
  return { servers: [...servers.values()], ...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}), errors };
}

export interface VariableContext {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly disallowShellSubstitution?: boolean;
}
/** Pure `${NAME}` expansion in env/headers/oauth.clientSecret; `!cmd` is never executed. */
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
  return {
    ...config,
    ...(config.env ? { env: map(config.env) } : {}),
    ...(config.headers ? { headers: map(config.headers) } : {}),
    ...(config.oauth ? { oauth: { ...config.oauth, ...(typeof config.oauth.clientSecret === "string" ? { clientSecret: sub(config.oauth.clientSecret) } : {}) } } : {}),
    ...(config.cwd !== undefined && ctx.cwd !== undefined ? { cwd: resolvePath(ctx.cwd, config.cwd) } : {}),
  };
}
