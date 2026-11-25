/**
 * mcp.json discovery, validation, and merging.
 *
 * Mirrors Pi's built-in rules (docs/mcp.md): user-level servers live in
 * ~/.pi/agent/mcp.json, project servers in .pi/mcp.json (trusted projects
 * only), a project entry replaces a user entry, and a project entry without
 * command/url/type overlays only enabled/exposure/toolExposure.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerEntry } from "./pi-api.ts";

export type Exposure = "direct" | "codemode" | "deferred" | "hidden";

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
	/** Present when the entry sets `oauth`: not supported by this bridge yet. */
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

	const base = {
		name,
		source,
		enabled: raw.enabled !== false,
		exposure: normalizeExposure(raw.exposure),
		timeoutMs: raw.timeout !== undefined && raw.timeout > 0 ? raw.timeout * 1000 : DEFAULT_TIMEOUT_MS,
		wantsOAuth: raw.oauth !== undefined,
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
