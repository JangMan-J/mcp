/**
 * Connection bridge: owns McpClient instances built from this library and
 * registers their tools with Pi, mirroring the built-in MCP exposure model
 * (codemode default; direct/deferred/hidden; per-tool toolExposure overrides).
 */

import { createHash } from "node:crypto";
import { McpClient } from "../dist/index.js";
import {
	createOps,
	normalizeContent,
	type Ops,
	type ToolCallResult,
	type ToolEntry,
} from "../dist/ops/index.js";
import { HttpTransport } from "../dist/transport-http/index.js";
import { StdioTransport } from "../dist/transport-stdio/index.js";
import type { Outcome } from "../dist/index.js";
import type { Exposure, ResolvedServerConfig } from "./config.ts";
import { convertBlocks } from "./content.ts";
import type { ExtensionAPI, ToolAnnotations, ToolResult } from "./pi-api.ts";

export type ServerStatus = "connecting" | "connected" | "error" | "disabled";

export interface ServerState {
	readonly name: string;
	config: ResolvedServerConfig;
	status: ServerStatus;
	toolCount: number;
	error?: string | undefined;
	description?: string | undefined;
	/** Full server instructions from server/discover, when offered. */
	instructions?: string | undefined;
	client?: McpClient | undefined;
	ops?: Ops | undefined;
	/** Pi tool names registered for this server (persist across reconnects). */
	readonly registeredTools: Set<string>;
	/** Exposures this server's tools were registered with. */
	readonly exposures: Set<Exposure>;
}

export function sanitizeNamePart(s: string): string {
	return s.replace(/[^A-Za-z0-9_]/g, "_");
}

function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

/**
 * Map server tool names to Pi tool names: mcp__<server>__<tool>, with a hash
 * suffix for every tool in a collision group (same rule as built-in MCP).
 */
export function assignToolNames(server: string, toolNames: readonly string[]): Map<string, string> {
	const prefix = `mcp__${sanitizeNamePart(server)}__`;
	const byBase = new Map<string, string[]>();
	for (const t of toolNames) {
		const base = prefix + sanitizeNamePart(t);
		const group = byBase.get(base);
		if (group) group.push(t);
		else byBase.set(base, [t]);
	}
	const out = new Map<string, string>();
	for (const [base, group] of byBase) {
		if (group.length === 1) {
			out.set(group[0] as string, base);
		} else {
			for (const t of group) out.set(t, `${base}_h${shortHash(t)}`);
		}
	}
	return out;
}

/** Per-tool exposure: exact toolExposure key, then first matching `*` pattern, else the server's. */
export function toolExposureFor(config: ResolvedServerConfig, toolName: string): Exposure {
	const overrides = config.toolExposure;
	if (overrides) {
		const exact = overrides[toolName];
		if (exact !== undefined) return normalizeOverride(exact);
		for (const [pattern, value] of Object.entries(overrides)) {
			if (!pattern.includes("*")) continue;
			const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`);
			if (re.test(toolName)) return normalizeOverride(value);
		}
	}
	return config.exposure;
}

function normalizeOverride(value: string): Exposure {
	return value === "direct" || value === "deferred" || value === "hidden" ? value : "codemode";
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function annotationsOf(entry: ToolEntry): ToolAnnotations | undefined {
	const v = entry.annotations?.value;
	if (typeof v !== "object" || v === null) return undefined;
	const rec = v as Record<string, unknown>;
	const out: ToolAnnotations = {};
	if (typeof rec.readOnlyHint === "boolean") out.readOnlyHint = rec.readOnlyHint;
	if (typeof rec.destructiveHint === "boolean") out.destructiveHint = rec.destructiveHint;
	if (typeof rec.idempotentHint === "boolean") out.idempotentHint = rec.idempotentHint;
	if (typeof rec.openWorldHint === "boolean") out.openWorldHint = rec.openWorldHint;
	return Object.keys(out).length > 0 ? out : undefined;
}

function inputSchemaOf(entry: ToolEntry): Record<string, unknown> {
	const schema = entry.tool.inputSchema;
	if (typeof schema === "object" && schema !== null && !Array.isArray(schema)) {
		return schema as Record<string, unknown>;
	}
	return { type: "object", properties: {} };
}

/** Transport-failure kinds worth one reconnect + retry. */
const RETRY_KINDS = new Set(["connect", "closed", "stream-broken", "process-exit"]);

export function describeOutcome(outcome: Exclude<Outcome<unknown>, { kind: "ok" }>): string {
	switch (outcome.kind) {
		case "jsonrpc-error":
			return `JSON-RPC error ${outcome.code}: ${outcome.message}`;
		case "transport-failure":
			return `${outcome.failure.kind}: ${outcome.failure.message}`;
		case "tool-isError":
			return "tool reported an error";
		case "cancelled":
			return "cancelled";
		case "uncertain-write":
			return `uncertain write (${outcome.uncertain.evidence}); not retried`;
		case "mrtr-interim":
			return "server requested mid-request input (elicitations are not supported yet)";
		case "task-handle":
			return "server returned a task handle (task-based calls are not supported yet)";
		default:
			return `${outcome.kind}: ${JSON.stringify("detail" in outcome ? outcome.detail : undefined)?.slice(0, 300)}`;
	}
}

export interface BridgeOptions {
	readonly pi: ExtensionAPI;
	readonly notify: (message: string, level: "info" | "warning" | "error") => void;
	/** Bound for connection waits from tool_call / before_agent_start. */
	readonly waitMs?: number;
}

export class McpBridge {
	private readonly pi: ExtensionAPI;
	private readonly notify: BridgeOptions["notify"];
	private readonly waitMs: number;
	private readonly states = new Map<string, ServerState>();
	private readonly pending = new Map<string, Promise<void>>();

	constructor(opts: BridgeOptions) {
		this.pi = opts.pi;
		this.notify = opts.notify;
		this.waitMs = opts.waitMs ?? 10_000;
	}

	get(name: string): ServerState | undefined {
		return this.states.get(name);
	}

	list(): ServerState[] {
		return [...this.states.values()];
	}

	/** Start connecting every enabled server in the background; mark the rest. */
	sync(configs: ReadonlyMap<string, ResolvedServerConfig>): void {
		for (const [name, cfg] of configs) {
			const existing = this.states.get(name);
			if (existing) {
				const changed = JSON.stringify(existing.config) !== JSON.stringify(cfg);
				existing.config = cfg;
				if (!cfg.enabled) {
					void this.teardown(existing);
					existing.status = "disabled";
					existing.error = undefined;
				} else if (changed || existing.status === "disabled" || existing.status === "error") {
					this.connectInBackground(existing);
				}
				continue;
			}
			const state: ServerState = {
				name,
				config: cfg,
				status: cfg.enabled ? "connecting" : "disabled",
				toolCount: 0,
				registeredTools: new Set(),
				exposures: new Set(),
			};
			this.states.set(name, state);
			if (cfg.enabled) this.connectInBackground(state);
		}
		// Servers removed from configuration: tear down, keep registrations inert.
		for (const [name, state] of this.states) {
			if (!configs.has(name) && state.status !== "disabled") {
				void this.teardown(state);
				state.status = "disabled";
				state.error = "removed from configuration";
			}
		}
	}

	private connectInBackground(state: ServerState): void {
		state.status = "connecting";
		state.error = undefined;
		const p = this.connect(state)
			.then(() => this.ensureReachTools())
			.catch(() => {});
		this.pending.set(state.name, p);
		void p.finally(() => {
			if (this.pending.get(state.name) === p) this.pending.delete(state.name);
		});
	}

	/** Wait for pending connections, bounded by waitMs. */
	async waitForPending(predicate?: (state: ServerState) => boolean): Promise<void> {
		const names = [...this.states.values()]
			.filter((s) => (predicate ? predicate(s) : true))
			.map((s) => s.name);
		const pending = names
			.map((n) => this.pending.get(n))
			.filter((p): p is Promise<void> => p !== undefined);
		if (pending.length === 0) return;
		await Promise.race([
			Promise.allSettled(pending),
			new Promise((resolve) => setTimeout(resolve, this.waitMs)),
		]);
	}

	async reconnect(name: string): Promise<ServerState> {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		await this.teardown(state);
		state.status = "connecting";
		state.error = undefined;
		state.toolCount = 0;
		await this.connect(state);
		this.ensureReachTools();
		return state;
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.pending.values()]);
		await Promise.allSettled([...this.states.values()].map((s) => this.teardown(s)));
		this.states.clear();
	}

	private async teardown(state: ServerState): Promise<void> {
		const client = state.client;
		state.client = undefined;
		state.ops = undefined;
		if (client) {
			try {
				await client.close({ graceMs: 500 });
			} catch {
				// close is best-effort
			}
		}
	}

	private buildClient(config: ResolvedServerConfig): McpClient {
		const transport =
			config.kind === "stdio"
				? new StdioTransport({
						command: config.command as string,
						args: config.args ?? [],
						...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
						...(config.env !== undefined ? { env: config.env } : {}),
					})
				: new HttpTransport({
						url: config.url as string,
						...(config.headers !== undefined ? { extraHeaders: config.headers } : {}),
					});
		return new McpClient({
			transport,
			server: { key: config.name, label: config.name },
			clientInfo: { name: "pi", version: "mcp-client-bridge" },
			defaults: { timeoutMs: config.timeoutMs },
		});
	}

	private async connect(state: ServerState): Promise<void> {
		const { config } = state;
		try {
			if (config.wantsOAuth) {
				this.notify(
					`mcp "${state.name}": oauth config is not supported by this bridge yet; connect may fail with 401`,
					"warning",
				);
			}
			const client = this.buildClient(config);
			const ops = createOps(client);
			state.client = client;
			state.ops = ops;

			// Best-effort server/discover for instructions used as namespace text.
			try {
				const discovered = await client.discover({ timeoutMs: 10_000 });
				if (discovered.kind === "ok") {
					const instructions = discovered.value.instructions;
					if (typeof instructions === "string" && instructions.trim() !== "") {
						state.description = config.description ?? instructions.split("\n")[0];
						state.instructions = instructions;
					}
				}
			} catch {
				// discover is optional metadata
			}
			if (state.description === undefined && config.description !== undefined) {
				state.description = config.description;
			}

			const listed = await ops.tools.listAll({ maxItems: 10_000 });
			if (listed.kind === "ok") {
				this.registerTools(state, listed.value.items);
				for (const warning of listed.value.warnings) {
					this.notify(`mcp "${state.name}": ${warning}`, "warning");
				}
			} else if (
				listed.kind === "capability-absent" ||
				(listed.kind === "jsonrpc-error" && listed.code === -32601)
			) {
				// Server without a tools capability: valid, just nothing to register.
			} else {
				throw new Error(describeOutcome(listed));
			}
			state.status = "connected";
			state.error = undefined;
		} catch (err) {
			state.status = "error";
			state.error = err instanceof Error ? err.message : String(err);
			await this.teardown(state);
			this.notify(`mcp "${state.name}": ${state.error}`, "error");
		}
	}

	private registerTools(state: ServerState, entries: readonly ToolEntry[]): void {
		const usable = entries.filter((e) => typeof e.name === "string" && e.name !== "");
		const names = assignToolNames(state.name, usable.map((e) => e.name));
		for (const entry of usable) {
			const piName = names.get(entry.name) as string;
			if (state.registeredTools.has(piName)) continue;
			const exposure = toolExposureFor(state.config, entry.name);
			const toolDescription =
				typeof entry.tool.description === "string" ? entry.tool.description : "";
			const annotations = annotationsOf(entry);
			this.pi.registerTool({
				name: piName,
				label: `${state.name}: ${entry.name}`,
				description: toolDescription || `MCP tool ${entry.name} on ${state.name}`,
				parameters: inputSchemaOf(entry),
				exposure,
				namespace: {
					name: `mcp__${sanitizeNamePart(state.name)}`,
					aliases: [state.name, state.name.replace(/-/g, "_")],
					...(state.description !== undefined ? { description: state.description } : {}),
					...(state.instructions !== undefined ? { instructions: state.instructions } : {}),
				},
				...(annotations !== undefined ? { annotations } : {}),
				promptSnippet: toolDescription.split("\n")[0] ?? "",
				execute: (_id, params, signal, onUpdate) =>
					this.callTool(state.name, entry.name, params, signal, onUpdate),
			});
			state.registeredTools.add(piName);
			state.exposures.add(exposure);
		}
		state.toolCount = state.registeredTools.size;
	}

	private async callTool(
		serverName: string,
		toolName: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolResult) => void) | undefined,
	): Promise<ToolResult> {
		let state = this.states.get(serverName);
		if (!state?.ops || state.status !== "connected") {
			throw new Error(
				`MCP server "${serverName}" is not connected (status: ${state?.status ?? "unknown"}${
					state?.error ? `, ${state.error}` : ""
				}). Run /mcp reconnect ${serverName}.`,
			);
		}
		const progress = (p: unknown) => {
			const msg = (p as { message?: unknown })?.message;
			if (typeof msg === "string" && onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `${serverName}/${toolName}: ${msg}` }],
					details: { server: serverName, tool: toolName },
				});
			}
		};
		let outcome = await state.ops.tools.call(toolName, params, {
			validateInput: false, // Pi already validated against the same schema
			allowUnvalidated: true,
			...(signal !== undefined ? { signal } : {}),
			onProgress: progress,
		});
		if (
			outcome.kind === "transport-failure" &&
			RETRY_KINDS.has(outcome.failure.kind) &&
			!(signal?.aborted ?? false)
		) {
			// Dropped connection: reconnect once and retry, like built-in MCP does.
			try {
				state = await this.reconnect(serverName);
			} catch {
				// fall through to reporting the original outcome
			}
			if (state.ops && state.status === "connected") {
				outcome = await state.ops.tools.call(toolName, params, {
					validateInput: false,
					allowUnvalidated: true,
					...(signal !== undefined ? { signal } : {}),
				});
			}
		}
		return this.outcomeToResult(serverName, toolName, outcome);
	}

	private outcomeToResult(
		serverName: string,
		toolName: string,
		outcome: Outcome<ToolCallResult>,
	): ToolResult {
		const details = { server: serverName, tool: toolName };
		if (outcome.kind === "ok") {
			const { value } = outcome;
			return {
				content: convertBlocks(value.content),
				details: { ...details, validation: value.validation.status },
				...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
			};
		}
		if (outcome.kind === "tool-isError") {
			const raw = outcome.result;
			return {
				content: convertBlocks(normalizeContent(raw.content)),
				details,
				isError: true,
				...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
			};
		}
		throw new Error(`mcp ${serverName}/${toolName}: ${describeOutcome(outcome)}`);
	}

	/**
	 * Mirror of built-in behavior: once a codemode-exposure server connects,
	 * activate codemode; for deferred, activate tool_search.
	 */
	ensureReachTools(): void {
		const exposures = new Set<Exposure>();
		for (const s of this.states.values()) {
			if (s.status === "connected") for (const e of s.exposures) exposures.add(e);
		}
		const autoEnable = this.pi.getSettings?.()?.autoEnableCodemode;
		const all = this.pi.getAllTools();
		const active = new Set(this.pi.getActiveTools());
		const wanted: string[] = [];
		if (exposures.has("codemode") && autoEnable !== false) wanted.push("codemode");
		if (exposures.has("deferred")) wanted.push("tool_search");
		const toAdd = wanted.filter((n) => all.some((t) => t.name === n) && !active.has(n));
		if (toAdd.length > 0) this.pi.setActiveTools([...active, ...toAdd]);
	}

	statusLines(): string[] {
		if (this.states.size === 0) return ["No MCP servers configured."];
		return [...this.states.values()].map((s) => {
			const base = `${s.name} (${s.config.kind}, ${s.config.source})`;
			switch (s.status) {
				case "connected":
					return `${base}: connected, ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`;
				case "connecting":
					return `${base}: connecting…`;
				case "disabled":
					return `${base}: disabled${s.error ? ` (${s.error})` : ""}`;
				case "error":
					return `${base}: error: ${s.error ?? "unknown"}`;
			}
		});
	}
}
