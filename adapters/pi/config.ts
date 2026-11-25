/**
 * mcp.json discovery, validation, and merging.
 *
 * Mirrors Pi's built-in rules (docs/mcp.md): user-level servers live in
 * ~/.pi/agent/mcp.json, project servers in .pi/mcp.json (trusted projects
 * only), a project entry replaces a user entry, and a project entry without
 * command/url/type overlays only enabled/exposure/toolExposure.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerEntry } from "./pi-api.ts";

export type Exposure = "direct" | "codemode" | "deferred" | "hidden";

export interface OAuthConfig {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly clientName?: string;
	/** Fixed loopback callback port (http://127.0.0.1:<port>/callback). */
	readonly callbackPort?: number;
	/** Full loopback redirect URI; takes precedence over callbackPort. */
	readonly callbackUrl?: string;
	/** Space-separated scopes requested when the server does not advertise them. */
	readonly scope?: string;
	/** Use this AS metadata document instead of discovery; trusted as configured. */
	readonly authServerMetadataUrl?: string;
}

export interface ResolvedServerConfig {
	readonly name: string;
	readonly source: "user" | "project" | "extension";
	readonly kind: "stdio" | "http";
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Record<string, string>;
	readonly enabled: boolean;
	readonly exposure: Exposure;
	readonly toolExposure?: Record<string, string>;
	readonly description?: string;
	readonly timeoutMs: number;
	/** Static client credentials / naming for the OAuth flow, when configured. */
	readonly oauth?: OAuthConfig;
	/** Present when the entry sets `oauth`. */
	readonly wantsOAuth: boolean;
}

export interface LoadedConfigs {
	readonly servers: Map<string, ResolvedServerConfig>;
	readonly warnings: string[];
}

export interface LoadOptions {
	readonly homeDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	/** Environment for `${VAR}` interpolation; defaults to process.env. */
	readonly env?: Record<string, string | undefined>;
	/** Runner for `!command` values; injectable for tests. */
	readonly exec?: (command: string) => string;
	/** Registered (extension) servers; file entries win on name collision. */
	readonly registered?: ReadonlyMap<string, McpServerEntry>;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(["direct", "codemode", "codemode-deferred", "deferred", "hidden"]);
const DEFAULT_TIMEOUT_MS = 60_000;

export function normalizeExposure(value: string | undefined): Exposure {
	switch (value) {
		case "direct":
		case "deferred":
		case "hidden":
			return value;
		default:
			return "codemode"; // codemode-deferred and unknown values land here
	}
}

/** Normalized identity: names differing only in `-` vs `_` are the same server. */
export function serverKey(name: string): string {
	return name.replace(/-/g, "_");
}

function defaultExec(command: string): string {
	return execSync(command, { encoding: "utf8", timeout: 10_000 }).trim();
}

/**
 * Interpolate one config value: `!command` (whole value) runs a command,
 * `${VAR}` reads from env. Returns undefined warnings-free value or the value
 * with failures replaced by "".
 */
export function interpolate(
	value: string,
	env: Record<string, string | undefined>,
	exec: (command: string) => string,
	warnings: string[],
	where: string,
): string {
	if (value.startsWith("!")) {
		try {
			return exec(value.slice(1));
		} catch (err) {
			warnings.push(`${where}: command failed: ${err instanceof Error ? err.message : String(err)}`);
			return "";
		}
	}
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
		const v = env[name];
		if (v === undefined) warnings.push(`${where}: environment variable ${name} is not set`);
		return v ?? "";
	});
}

export function expandTilde(path: string, homeDir: string): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return join(homeDir, path.slice(2));
	return path;
}

/** Persist enabled/exposure changes to the server's mcp.json file. */
export function persistServerUpdate(
	name: string,
	source: "user" | "project" | "extension",
	updates: { enabled?: boolean; exposure?: string },
	opts: { homeDir: string; cwd: string },
): void {
	const path = source === "project"
		? join(opts.cwd, ".pi", "mcp.json")
		: join(agentDir(process.env as Record<string, string | undefined>, opts.homeDir), "mcp.json");
	let doc: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
	if (existsSync(path)) doc = JSON.parse(readFileSync(path, "utf8")) as typeof doc;
	doc.mcpServers ??= {};
	const existing = doc.mcpServers[name];
	doc.mcpServers[name] = {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		...updates,
	};
	writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function interpolateRecord(
	record: Record<string, string>,
	env: Record<string, string | undefined>,
	exec: (command: string) => string,
	warnings: string[],
	where: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(record)) {
		out[k] = interpolate(v, env, exec, warnings, `${where}.${k}`);
	}
	return out;
}

interface RawEntry {
	readonly name: string;
	readonly raw: McpServerEntry;
	readonly source: "user" | "project" | "extension";
}

function readFileEntries(path: string, source: "user" | "project", warnings: string[]): RawEntry[] {
	if (!existsSync(path)) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		return [];
	}
	const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
	if (servers === undefined || servers === null) return [];
	if (typeof servers !== "object" || Array.isArray(servers)) {
		warnings.push(`${path}: "mcpServers" must be an object`);
		return [];
	}
	return Object.entries(servers as Record<string, unknown>).map(([name, raw]) => ({
		name,
		raw: (raw ?? {}) as McpServerEntry,
		source,
	}));
}

function isPartialOverride(raw: McpServerEntry): boolean {
	return raw.command === undefined && raw.url === undefined && raw.type === undefined;
}

function resolveOAuth(
	raw: McpServerEntry,
	env: Record<string, string | undefined>,
	exec: (command: string) => string,
	warnings: string[],
	where: string,
): OAuthConfig | undefined {
	if (raw.oauth === undefined) return undefined;
	const out: { clientId?: string; clientSecret?: string; clientName?: string; callbackPort?: number; callbackUrl?: string; scope?: string; authServerMetadataUrl?: string } = {};
	for (const key of ["clientId", "clientSecret", "clientName", "callbackUrl", "scope", "authServerMetadataUrl"] as const) {
		const v = raw.oauth[key];
		if (v === undefined) continue;
		if (typeof v !== "string") {
			warnings.push(`${where}: oauth.${key} must be a string`);
			continue;
		}
		out[key] = key === "clientName" ? v : interpolate(v, env, exec, warnings, `${where}.oauth.${key}`);
	}
	if (raw.oauth.callbackPort !== undefined) {
		const p = raw.oauth.callbackPort;
		if (typeof p === "number" && Number.isInteger(p) && p > 0 && p < 65536) out.callbackPort = p;
		else warnings.push(`${where}: oauth.callbackPort must be an integer port`);
	}
	return out;
}

function resolveEntry(
	entry: RawEntry,
	opts: LoadOptions,
	warnings: string[],
): ResolvedServerConfig | undefined {
	const { name, raw, source } = entry;
	const where = `${source} server "${name}"`;
	if (!NAME_RE.test(name)) {
		warnings.push(`${where}: invalid name (allowed: letters, digits, _, -)`);
		return undefined;
	}
	if (raw.type !== undefined && raw.type !== "stdio" && raw.type !== "http" && raw.type !== "streamable-http") {
		warnings.push(`${where}: unsupported type ${JSON.stringify(raw.type)} (sse is not supported)`);
		return undefined;
	}
	if (raw.exposure !== undefined && !EXPOSURES.has(raw.exposure)) {
		warnings.push(`${where}: unknown exposure ${JSON.stringify(raw.exposure)}, using "codemode"`);
	}
	for (const [pattern, value] of Object.entries(raw.toolExposure ?? {})) {
		if (!EXPOSURES.has(value)) {
			warnings.push(`${where}: unknown toolExposure ${JSON.stringify(value)} for ${pattern}`);
		}
	}

	const env = opts.env ?? process.env;
	const exec = opts.exec ?? defaultExec;

	const oauth = resolveOAuth(raw, env, exec, warnings, where);

	const base = {
		name,
		source,
		enabled: raw.enabled !== false,
		exposure: normalizeExposure(raw.exposure),
		timeoutMs: raw.timeout !== undefined && raw.timeout > 0 ? raw.timeout * 1000 : DEFAULT_TIMEOUT_MS,
		wantsOAuth: raw.oauth !== undefined,
		...(oauth !== undefined ? { oauth } : {}),
		...(raw.toolExposure !== undefined ? { toolExposure: raw.toolExposure } : {}),
		...(raw.description !== undefined ? { description: raw.description } : {}),
	};

	if (raw.command !== undefined) {
		return {
			...base,
			kind: "stdio",
			command: expandTilde(raw.command, opts.homeDir),
			args: (raw.args ?? []).map((a) => expandTilde(a, opts.homeDir)),
			...(raw.env !== undefined
				? { env: interpolateRecord(raw.env, env, exec, warnings, where) }
				: {}),
			...(raw.cwd !== undefined ? { cwd: expandTilde(raw.cwd, opts.homeDir) } : {}),
		};
	}
	if (raw.url !== undefined) {
		return {
			...base,
			kind: "http",
			url: raw.url,
			...(raw.headers !== undefined
				? { headers: interpolateRecord(raw.headers, env, exec, warnings, where) }
				: {}),
		};
	}
	warnings.push(`${where}: needs "command" (stdio) or "url" (http)`);
	return undefined;
}

/**
 * Directory holding mcp.json: PI_CODING_AGENT_DIR when set, else
 * ~/.pi/agent. Mirrors Pi's own resolution (docs/environment-variables.md).
 */
export function agentDir(env: Record<string, string | undefined>, homeDir: string): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (typeof override === "string" && override !== "") return override;
	return join(homeDir, ".pi", "agent");
}

/**
 * Load and merge user-level and project-level mcp.json, plus servers
 * registered by other extensions. File entries take precedence over
 * registered ones; project entries take precedence over user entries.
 */
export function loadServerConfigs(opts: LoadOptions): LoadedConfigs {
	const warnings: string[] = [];
	const merged = new Map<string, ResolvedServerConfig>();
	const seenKeys = new Map<string, string>(); // normalized key -> first name

	const userEntries = readFileEntries(
		join(agentDir(opts.env ?? (process.env as Record<string, string | undefined>), opts.homeDir), "mcp.json"),
		"user",
		warnings,
	);
	const projectEntries = opts.projectTrusted
		? readFileEntries(join(opts.cwd, ".pi", "mcp.json"), "project", warnings)
		: [];

	// Extension-registered servers first: file config overrides them by name.
	if (opts.registered) {
		for (const [name, raw] of opts.registered) {
			const cfg = resolveEntry({ name, raw, source: "extension" }, opts, warnings);
			if (cfg) {
				merged.set(name, cfg);
				seenKeys.set(serverKey(name), name);
			}
		}
	}

	const applyFile = (entries: RawEntry[], overlayOnly: boolean) => {
		for (const entry of entries) {
			const key = serverKey(entry.name);
			const priorName = seenKeys.get(key);
			if (priorName !== undefined && priorName !== entry.name) {
				warnings.push(
					`${entry.source} server "${entry.name}": conflicts with "${priorName}" (names differ only in -/_), skipping`,
				);
				continue;
			}
			if (overlayOnly && isPartialOverride(entry.raw)) {
				const base = merged.get(entry.name);
				if (!base) {
					warnings.push(
						`project server "${entry.name}": partial override without a matching user-level server`,
					);
					continue;
				}
				merged.set(entry.name, {
					...base,
					enabled: entry.raw.enabled !== undefined ? entry.raw.enabled !== false : base.enabled,
					exposure: entry.raw.exposure !== undefined ? normalizeExposure(entry.raw.exposure) : base.exposure,
					...(entry.raw.toolExposure !== undefined ? { toolExposure: entry.raw.toolExposure } : {}),
				});
				continue;
			}
			const cfg = resolveEntry(entry, opts, warnings);
			if (cfg) {
				merged.set(entry.name, cfg);
				seenKeys.set(key, entry.name);
			}
		}
	};

	applyFile(userEntries, false);
	applyFile(projectEntries, true);

	return { servers: merged, warnings };
}
