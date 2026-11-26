/**
 * mcp.json discovery, validation, and merging.
 *
 * Mirrors Pi's built-in rules (docs/mcp.md): user-level servers live in
 * ~/.pi/agent/mcp.json (or $PI_CODING_AGENT_DIR/mcp.json), project servers in
 * .pi/mcp.json (trusted projects only), a project entry replaces a user entry,
 * and a project entry without command/url/type overlays only enabled, exposure,
 * toolExposure, subscribe, and eventDelivery (never credentials).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { EventDeliveryMode, McpServerEntry, McpSubscriptionSpecEntry } from "./pi-api.ts";

export type Exposure = "direct" | "codemode" | "deferred" | "hidden";

export interface OAuthConfig {
	readonly clientId?: string;
	readonly clientSecret?: string;
	readonly clientName?: string;
	/** Fixed loopback callback port (http://127.0.0.1:<port>/callback). */
	readonly callbackPort?: number;
	/** Full redirect URI; loopback HTTP binds a fixed port, an https URL is hosted by the callback server. */
	readonly callbackUrl?: string;
	/** Space-separated scopes requested when the server does not advertise them. */
	readonly scope?: string;
	/** Use this AS metadata document instead of discovery; trusted as configured. */
	readonly authServerMetadataUrl?: string;
}

export interface ResolvedServerConfig {
	readonly name: string;
	readonly source: "user" | "project" | "extension";
	/** True when a project .pi/mcp.json partial override modified a user server. */
	readonly hasProjectOverride?: boolean;
	readonly kind: "stdio" | "http";
	readonly command?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
	readonly cwd?: string;
	readonly url?: string;
	readonly headers?: Record<string, string>;
	readonly authProvider?: string;
	readonly enabled: boolean;
	readonly exposure: Exposure;
	readonly toolExposure?: Record<string, string>;
	readonly subscribe?: boolean | readonly (string | McpSubscriptionSpecEntry)[];
	readonly eventDelivery?: EventDeliveryMode;
	readonly description?: string;
	readonly timeoutMs: number;
	/** Static client credentials / naming for the OAuth flow, when configured. */
	readonly oauth?: OAuthConfig;
	/** Present when the entry sets `oauth`. */
	readonly wantsOAuth: boolean;
}

export interface LoadedConfigs {
	readonly servers: Map<string, ResolvedServerConfig>;
	readonly fileServers: Map<string, ResolvedServerConfig>;
	readonly overriddenExtensions: string[];
	readonly autoEnableCodemode?: boolean;
	readonly warnings: string[];
}

export interface LoadOptions {
	readonly homeDir: string;
	readonly cwd: string;
	readonly projectTrusted: boolean;
	/** Environment for `${VAR}` / `${VAR:-fallback}` interpolation; defaults to process.env. */
	readonly env?: Record<string, string | undefined>;
	/** Runner for `!command` values; injectable for tests. */
	readonly exec?: (command: string) => string;
	/** Registered (extension) servers; file entries win on name collision. */
	readonly registered?: ReadonlyMap<string, McpServerEntry>;
}

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXPOSURES = new Set(["direct", "codemode", "codemode-deferred", "deferred", "hidden"]);
const EVENT_DELIVERIES = new Set(["followUp", "steer", "nextTurn"]);
const PARTIAL_OVERRIDE_KEYS = new Set(["enabled", "exposure", "toolExposure", "subscribe", "eventDelivery"]);
const DEFAULT_TIMEOUT_MS = 60_000;

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function normalizeExposure(value: string | undefined): Exposure {
	switch (value) {
		case "direct":
		case "deferred":
		case "hidden":
			return value;
		default:
			return "codemode";
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
 * `${VAR}` and `${VAR:-fallback}` read from env.
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
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
		const v = env[name];
		if (v !== undefined && v !== "") return v;
		if (fallback !== undefined) return fallback;
		if (v === undefined) warnings.push(`${where}: environment variable ${name} is not set`);
		return v ?? "";
	});
}

export function expandTilde(path: string, homeDir: string): string {
	if (path === "~") return homeDir;
	if (path.startsWith("~/")) return join(homeDir, path.slice(2));
	return path;
}

/** Persist enabled/exposure changes to the server's mcp.json file, preserving indentation. */
export function persistServerUpdate(
	name: string,
	source: "user" | "project" | "extension",
	updates: { enabled?: boolean; exposure?: string },
	opts: { homeDir: string; cwd: string; env?: Record<string, string | undefined>; hasProjectOverride?: boolean },
): void {
	if (source === "extension") return;
	const targetSource = opts.hasProjectOverride ? "project" : source;
	const path =
		targetSource === "project"
			? join(opts.cwd, ".pi", "mcp.json")
			: join(agentDir(opts.env ?? (process.env as Record<string, string | undefined>), opts.homeDir), "mcp.json");
	const rawText = existsSync(path) ? stripBom(readFileSync(path, "utf8")) : undefined;
	const indent = (rawText && /^([ \t]+)\S/m.exec(rawText)?.[1]) || "  ";
	const doc: { mcpServers?: Record<string, unknown> } =
		rawText !== undefined ? (JSON.parse(rawText) as { mcpServers?: Record<string, unknown> }) : { mcpServers: {} };
	doc.mcpServers ??= {};
	const existing = doc.mcpServers[name];
	doc.mcpServers[name] = {
		...(typeof existing === "object" && existing !== null ? existing : {}),
		...updates,
	};
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(doc, null, indent)}\n`);
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

function readFileConfig(
	path: string,
	source: "user" | "project",
	warnings: string[],
): { entries: RawEntry[]; autoEnableCodemode?: boolean } {
	if (!existsSync(path)) return { entries: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch (err) {
		warnings.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
		return { entries: [] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push(`${path}: expected a JSON object`);
		return { entries: [] };
	}
	const rec = parsed as { mcpServers?: unknown; autoEnableCodemode?: unknown };
	let autoEnableCodemode: boolean | undefined;
	if (typeof rec.autoEnableCodemode === "boolean") {
		autoEnableCodemode = rec.autoEnableCodemode;
	} else if (rec.autoEnableCodemode !== undefined) {
		warnings.push(`${path}: "autoEnableCodemode" must be a boolean`);
	}
	const servers = rec.mcpServers;
	if (servers === undefined || servers === null) {
		return { entries: [], ...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}) };
	}
	if (typeof servers !== "object" || Array.isArray(servers)) {
		warnings.push(`${path}: "mcpServers" must be an object`);
		return { entries: [], ...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}) };
	}
	const entries = Object.entries(servers as Record<string, unknown>).map(([name, raw]) => ({
		name,
		raw: (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as McpServerEntry,
		source,
	}));
	return { entries, ...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}) };
}

function isPartialOverride(raw: McpServerEntry): boolean {
	return raw.command === undefined && raw.url === undefined && raw.type === undefined;
}

function parseSubscribe(
	raw: unknown,
	warnings: string[],
	where: string,
): boolean | readonly (string | McpSubscriptionSpecEntry)[] | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	if (!Array.isArray(raw)) {
		warnings.push(`${where}: "subscribe" must be a boolean or array`);
		return undefined;
	}
	const out: (string | McpSubscriptionSpecEntry)[] = [];
	for (const item of raw) {
		if (typeof item === "string" && item.trim() !== "") {
			out.push(item.trim());
		} else if (
			typeof item === "object" &&
			item !== null &&
			!Array.isArray(item) &&
			typeof (item as { name?: unknown }).name === "string" &&
			(item as { name: string }).name.trim() !== ""
		) {
			const spec = item as Record<string, unknown>;
			out.push({
				name: (spec.name as string).trim(),
				...(typeof spec.arguments === "object" && spec.arguments !== null && !Array.isArray(spec.arguments)
					? { arguments: spec.arguments as Record<string, unknown> }
					: {}),
				...(typeof spec.holdSettle === "boolean" ? { holdSettle: spec.holdSettle } : {}),
				...(typeof spec.maxAgeMs === "number" ? { maxAgeMs: spec.maxAgeMs } : {}),
				...(typeof spec.heartbeatMs === "number" ? { heartbeatMs: spec.heartbeatMs } : {}),
			});
		} else {
			warnings.push(`${where}: invalid subscribe item`);
		}
	}
	return out;
}

function resolveOAuth(
	raw: McpServerEntry,
	env: Record<string, string | undefined>,
	exec: (command: string) => string,
	warnings: string[],
	where: string,
): OAuthConfig | undefined {
	if (raw.oauth === undefined) return undefined;
	const out: {
		clientId?: string;
		clientSecret?: string;
		clientName?: string;
		callbackPort?: number;
		callbackUrl?: string;
		scope?: string;
		authServerMetadataUrl?: string;
	} = {};
	for (const key of [
		"clientId",
		"clientSecret",
		"clientName",
		"callbackUrl",
		"scope",
		"authServerMetadataUrl",
	] as const) {
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
	// Security invariant (docs/mcp.md): project .pi/mcp.json cannot set auth or oauth credentials.
	if (source === "project" && (raw.oauth !== undefined || raw.auth !== undefined)) {
		warnings.push(`${where}: auth/oauth is only allowed in the user-level mcp.json`);
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
	if (raw.eventDelivery !== undefined && !EVENT_DELIVERIES.has(raw.eventDelivery)) {
		warnings.push(`${where}: unknown eventDelivery ${JSON.stringify(raw.eventDelivery)}`);
	}

	const env = opts.env ?? process.env;
	const exec = opts.exec ?? defaultExec;

	const oauth = resolveOAuth(raw, env, exec, warnings, where);
	const subscribe = parseSubscribe(raw.subscribe, warnings, where);
	const eventDelivery =
		raw.eventDelivery !== undefined && EVENT_DELIVERIES.has(raw.eventDelivery)
			? raw.eventDelivery
			: undefined;
	const authProvider =
		typeof raw.auth?.provider === "string" && raw.auth.provider.trim() !== ""
			? raw.auth.provider.trim()
			: undefined;

	const base = {
		name,
		source,
		enabled: raw.enabled !== false,
		exposure: normalizeExposure(raw.exposure),
		timeoutMs: raw.timeout !== undefined && raw.timeout > 0 ? raw.timeout * 1000 : DEFAULT_TIMEOUT_MS,
		wantsOAuth: raw.oauth !== undefined,
		...(oauth !== undefined ? { oauth } : {}),
		...(authProvider !== undefined ? { authProvider } : {}),
		...(raw.toolExposure !== undefined ? { toolExposure: raw.toolExposure } : {}),
		...(subscribe !== undefined ? { subscribe } : {}),
		...(eventDelivery !== undefined ? { eventDelivery } : {}),
		...(raw.description !== undefined ? { description: raw.description } : {}),
	};

	if (raw.command !== undefined) {
		const expandedCmd = expandTilde(interpolate(raw.command, env, exec, warnings, `${where}.command`), opts.homeDir);
		const expandedArgs = (raw.args ?? []).map((a, idx) =>
			expandTilde(interpolate(a, env, exec, warnings, `${where}.args[${idx}]`), opts.homeDir),
		);
		let resolvedCwd = opts.cwd;
		if (raw.cwd !== undefined) {
			const interpCwd = expandTilde(interpolate(raw.cwd, env, exec, warnings, `${where}.cwd`), opts.homeDir);
			resolvedCwd = isAbsolute(interpCwd) ? interpCwd : resolve(opts.cwd, interpCwd);
		}
		return {
			...base,
			kind: "stdio",
			command: expandedCmd,
			args: expandedArgs,
			cwd: resolvedCwd,
			...(raw.env !== undefined ? { env: interpolateRecord(raw.env, env, exec, warnings, where) } : {}),
		};
	}
	if (raw.url !== undefined) {
		return {
			...base,
			kind: "http",
			url: interpolate(raw.url, env, exec, warnings, `${where}.url`),
			...(raw.headers !== undefined ? { headers: interpolateRecord(raw.headers, env, exec, warnings, where) } : {}),
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
	const fileServers = new Map<string, ResolvedServerConfig>();
	const seenFileKeys = new Map<string, string>();
	let autoEnableCodemode: boolean | undefined;

	const userFile = readFileConfig(
		join(agentDir(opts.env ?? (process.env as Record<string, string | undefined>), opts.homeDir), "mcp.json"),
		"user",
		warnings,
	);
	if (userFile.autoEnableCodemode !== undefined) autoEnableCodemode = userFile.autoEnableCodemode;

	const projectFile = opts.projectTrusted
		? readFileConfig(join(opts.cwd, ".pi", "mcp.json"), "project", warnings)
		: { entries: [] as RawEntry[] };
	if (projectFile.autoEnableCodemode !== undefined) autoEnableCodemode = projectFile.autoEnableCodemode;

	const applyFile = (entries: RawEntry[], overlayOnly: boolean) => {
		for (const entry of entries) {
			const key = serverKey(entry.name);
			const priorName = seenFileKeys.get(key);
			if (priorName !== undefined && priorName !== entry.name) {
				warnings.push(
					`${entry.source} server "${entry.name}": conflicts with "${priorName}" (names differ only in -/_), skipping`,
				);
				continue;
			}
			if (overlayOnly && isPartialOverride(entry.raw)) {
				const extraKeys = Object.keys(entry.raw).filter((k) => !PARTIAL_OVERRIDE_KEYS.has(k));
				if (extraKeys.length > 0) {
					warnings.push(
						`project server "${entry.name}": partial override can only set ${[...PARTIAL_OVERRIDE_KEYS].join(", ")} (got ${extraKeys.join(", ")})`,
					);
					continue;
				}
				const base = fileServers.get(entry.name);
				if (!base) {
					warnings.push(`project server "${entry.name}": partial override without a matching user-level server`);
					continue;
				}
				const sub = parseSubscribe(entry.raw.subscribe, warnings, `project server "${entry.name}"`);
				fileServers.set(entry.name, {
					...base,
					hasProjectOverride: true,
					enabled: entry.raw.enabled !== undefined ? entry.raw.enabled !== false : base.enabled,
					exposure: entry.raw.exposure !== undefined ? normalizeExposure(entry.raw.exposure) : base.exposure,
					...(entry.raw.toolExposure !== undefined ? { toolExposure: entry.raw.toolExposure } : {}),
					...(sub !== undefined ? { subscribe: sub } : {}),
					...(entry.raw.eventDelivery !== undefined && EVENT_DELIVERIES.has(entry.raw.eventDelivery)
						? { eventDelivery: entry.raw.eventDelivery }
						: {}),
				});
				continue;
			}
			const cfg = resolveEntry(entry, opts, warnings);
			if (cfg) {
				fileServers.set(entry.name, cfg);
				seenFileKeys.set(key, entry.name);
			}
		}
	};

	applyFile(userFile.entries, false);
	applyFile(projectFile.entries, true);

	const merged = new Map<string, ResolvedServerConfig>(fileServers);
	const overriddenExtensions: string[] = [];
	const seenAllKeys = new Map<string, string>(seenFileKeys);

	if (opts.registered) {
		for (const [name, raw] of opts.registered) {
			const key = serverKey(name);
			const fileMatch = seenFileKeys.get(key);
			if (fileMatch !== undefined) {
				overriddenExtensions.push(`"${name}" registered by extension is overridden by "${fileMatch}" in mcp.json`);
				continue;
			}
			const priorExt = seenAllKeys.get(key);
			if (priorExt !== undefined && priorExt !== name) continue;
			const cfg = resolveEntry({ name, raw, source: "extension" }, opts, warnings);
			if (cfg) {
				merged.set(name, cfg);
				seenAllKeys.set(key, name);
			}
		}
	}

	return {
		servers: merged,
		fileServers,
		overriddenExtensions,
		...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}),
		warnings,
	};
}
