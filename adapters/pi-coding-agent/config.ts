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
  readonly oauth?: Readonly<Record<string, unknown>>;
}
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
export function readLegacyConfig(input: unknown, opts: ReadOptions = {}): LegacyServerConfig[] {
  const source = opts.source ?? "global";
  const trusted = opts.trusted ?? opts.trust ?? source !== "project";
  if (source === "project" && !trusted) return []; // PICA-3: before inspecting input
  if (!isRec(input) || !isRec(input.mcpServers)) bad("expected { mcpServers: { ... } }");
  return Object.entries(input.mcpServers).map(([name, raw]) => {
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
      ...(raw.oauth ? { oauth: { ...raw.oauth as Rec } } : {}),
    };
  });
}
