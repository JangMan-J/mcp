/**
 * Connection bridge: owns McpClient instances built from this library and
 * registers their tools and SEP-3415 push-event subscriptions with Pi,
 * mirroring Pi's built-in MCP exposure, schema, and lifecycle rules.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { McpClient, type Outcome } from "@jangmanj/mcp/core";
import { createEventsExtension } from "@jangmanj/mcp/ext-events";
import {
	createSkillsExtension,
	MemorySkillCache,
	type SkillEntry,
	type SkillsClient,
} from "@jangmanj/mcp/ext-skills";
import { createTasksExtension } from "@jangmanj/mcp/mrtr-cache";
import {
	createOps,
	normalizeContent,
	type ContentBlock,
	type Ops,
	type ToolCallResult,
	type ToolEntry,
} from "@jangmanj/mcp/ops";
import { HttpTransport } from "@jangmanj/mcp/transport-http";
import { StdioTransport } from "@jangmanj/mcp/transport-stdio";
import { normalizeExposure, type Exposure, type ResolvedServerConfig } from "./config.ts";
import { convertBlocksOffloaded } from "./content-offloaded.ts";
import { DiagnosticsLog } from "./diagnostics.ts";
import { callWithElicitation, consentPort } from "./elicitation.ts";
import { startPiMcpEvents, type McpEvent, type PiMcpEventsHandle } from "./events.ts";
import { canonicalResource, createOAuthProvider, FileCredentialStore } from "./oauth.ts";
import type { ExtensionAPI, ToolAnnotations, ToolDefinition, ToolExposure, ToolResult, Ui } from "./pi-api.ts";
import { ResourceTools } from "./resources.ts";
import { createMcpResultSchema, normalizeMcpInputSchema } from "./schema.ts";
import { createServerSkillsClient, formatOriginTaggedSkill, hasSkills, SkillTools } from "./skills.ts";
import { cancelTask, getTask, taskHandleResult, TaskTools } from "./tasks.ts";

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
	/** Set when the server rejected unauthenticated requests. */
	authRequired?: boolean | undefined;
	/** Closes the loopback redirect listener of an OAuth provider, if any. */
	closeRedirect?: (() => void) | undefined;
	/** Capabilities from server/discover, when available. */
	capabilities?: Record<string, unknown> | undefined;
	/** Closes the subscriptions/listen stream, if any. */
	listenClose?: (() => void) | undefined;
	/** Active SEP-3415 push-events handle, if subscribed. */
	eventsHandle?: PiMcpEventsHandle | undefined;
	/** Active SEP-2640 skills client, if advertised. */
	skillsClient?: SkillsClient | undefined;
	/** Enumerated SEP-2640 skills (frontmatter/manifest only, lazy body). */
	skills?: readonly SkillEntry[] | undefined;
	/** Registered definitions by Pi tool name (for updates/withdrawal). */
	readonly definitions: Map<string, ToolDefinition>;
	/** Pi tool name -> server tool name. */
	readonly toolNames: Map<string, string>;
	/** Pi tool names registered for this server (persist across reconnects). */
	readonly registeredTools: Set<string>;
	/** Configured MCP exposures this server's tools use. */
	readonly exposures: Set<Exposure>;
}

export function sanitizeNamePart(s: string): string {
	return s.replace(/[^A-Za-z0-9_]/g, "_");
}

function shortHash(s: string): string {
	return createHash("sha1").update(s).digest("hex").slice(0, 8);
}

/**
 * Map MCP exposure to Pi's ToolDefinition.exposure (mirrors Pi's tools.ts):
 * `codemode` registers as `deferred` so tools stay out of `codemode`'s prompt
 * description (preserving prompt caches when servers connect in the background),
 * while `ensureReachTools()` activates `codemode`.
 */
export function toPiToolExposure(exposure: Exposure): ToolExposure {
	return exposure === "codemode" ? "deferred" : exposure;
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
		if (exact !== undefined) return normalizeExposure(exact);
		for (const [pattern, value] of Object.entries(overrides)) {
			if (!pattern.includes("*")) continue;
			const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`);
			if (re.test(toolName)) return normalizeExposure(value);
		}
	}
	return config.exposure;
}

/** Configured exposures known statically from mcp.json before the server connects. */
export function configuredExposuresOf(config: ResolvedServerConfig): Set<Exposure> {
	const set = new Set<Exposure>([config.exposure]);
	for (const val of Object.values(config.toolExposure ?? {})) {
		set.add(normalizeExposure(val));
	}
	return set;
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

function stripWireBlockMeta(block: ContentBlock): Record<string, unknown> {
	const raw =
		typeof block.raw === "object" && block.raw !== null && !Array.isArray(block.raw)
			? (block.raw as Record<string, unknown>)
			: { type: block.type };
	const { _meta: _ignored, ...rest } = raw;
	return rest;
}

/** Transport-failure kinds worth one reconnect + retry. */
const RETRY_KINDS = new Set(["connect", "closed", "stream-broken", "process-exit"]);

function isAuthOutcome(outcome: Outcome<unknown>): boolean {
	if (outcome.kind === "auth-failure" || outcome.kind === "auth-unavailable") return true;
	return (
		outcome.kind === "transport-failure" &&
		(outcome.failure.kind === "auth-failure" || outcome.failure.kind === "auth-unavailable")
	);
}

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
	/** Path of the OAuth credential store file; enables OAuth for HTTP servers. */
	readonly credentialStorePath?: string;
	/** Host confirm dialog for OAuth consent prompts. */
	readonly confirm?: (title: string, message: string) => Promise<boolean>;
	/** Browser opener override (tests); defaults to the system browser. */
	readonly browserOpen?: (url: string, signal: AbortSignal) => Promise<void>;
	/** Allow OAuth against insecure loopback HTTP (local dev servers, tests). */
	readonly allowInsecureAuth?: boolean;
	/** Host UI for elicitation prompts; without it elicitations decline. */
	readonly ui?: Ui;
	/** Diagnostics log path (mcp.log). */
	readonly diagnosticsLogPath?: string;
	/** Resolve provider token for `auth: { provider }` HTTP entries. */
	readonly providerToken?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Custom push-event delivery hook; defaults to `pi.sendMessage`. */
	readonly onPushEvent?: (text: string, event: McpEvent, config: ResolvedServerConfig) => Promise<void> | void;
}

export class McpBridge {
	private readonly pi: ExtensionAPI;
	private readonly notify: BridgeOptions["notify"];
	private readonly waitMs: number;
	private readonly states = new Map<string, ServerState>();
	private readonly pending = new Map<string, Promise<void>>();
	private readonly credentials: FileCredentialStore | undefined;
	private readonly credentialStorePath: string | undefined;
	private readonly confirm: BridgeOptions["confirm"];
	private readonly browserOpen: BridgeOptions["browserOpen"];
	private readonly allowInsecureAuth: boolean;
	private readonly resourceTools: ResourceTools;
	private readonly skillTools: SkillTools;
	private readonly taskTools: TaskTools;
	private readonly skillCache = new MemorySkillCache();
	private readonly exposureByServer = new Map<string, Exposure>();
	private readonly toolOwner = new Map<string, string>(); // piToolName -> serverName
	private readonly eventCursors = new Map<string, string>();
	private readonly seenEventIds = new Set<string>();
	private readonly ui: Ui;
	private readonly log: DiagnosticsLog | undefined;
	private readonly providerToken: BridgeOptions["providerToken"];
	private readonly onPushEvent: BridgeOptions["onPushEvent"];
	private autoEnableCodemodeOverride: boolean | undefined;
	private warnedUnreachable = false;
	private lastAuthFileMtimeMs: number | undefined;
	/** Server name for which an interactive login (/mcp login) is armed. */
	private loginArmed: string | undefined;

	constructor(opts: BridgeOptions) {
		this.pi = opts.pi;
		this.notify = opts.notify;
		this.waitMs = opts.waitMs ?? 10_000;
		this.credentialStorePath = opts.credentialStorePath;
		this.credentials =
			opts.credentialStorePath !== undefined ? new FileCredentialStore(opts.credentialStorePath) : undefined;
		this.confirm = opts.confirm;
		this.browserOpen = opts.browserOpen;
		this.allowInsecureAuth = opts.allowInsecureAuth ?? false;
		this.ui = opts.ui ?? { notify: () => {} };
		this.log = opts.diagnosticsLogPath !== undefined ? new DiagnosticsLog(opts.diagnosticsLogPath) : undefined;
		this.providerToken = opts.providerToken;
		this.onPushEvent = opts.onPushEvent;
		const liveStates = () => this.list().map((s) => ({ ...s, enabled: s.config.enabled }));
		this.resourceTools = new ResourceTools(this.pi, liveStates, this.exposureByServer);
		this.skillTools = new SkillTools(this.pi, liveStates, this.exposureByServer);
		this.taskTools = new TaskTools(this.pi, liveStates, this.exposureByServer);
	}

	get(name: string): ServerState | undefined {
		return this.states.get(name);
	}

	list(): ServerState[] {
		return [...this.states.values()];
	}

	ownerOfTool(piToolName: string): string | undefined {
		return this.toolOwner.get(piToolName);
	}

	setAutoEnableCodemode(value: boolean | undefined): void {
		this.autoEnableCodemodeOverride = value;
	}

	resetSessionState(): void {
		this.warnedUnreachable = false;
		this.eventCursors.clear();
		this.seenEventIds.clear();
	}

	/** Start connecting every enabled server in the background; mark the rest. */
	sync(configs: ReadonlyMap<string, ResolvedServerConfig>): void {
		for (const [name, cfg] of configs) {
			this.exposureByServer.set(name, cfg.exposure);
			const existing = this.states.get(name);
			if (existing) {
				const changed = JSON.stringify(existing.config) !== JSON.stringify(cfg);
				existing.config = cfg;
				if (!cfg.enabled) {
					this.hideServerTools(existing);
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
				definitions: new Map(),
				toolNames: new Map(),
			};
			this.states.set(name, state);
			if (cfg.enabled) this.connectInBackground(state);
		}
		// Servers removed from configuration: hide tools and tear down.
		for (const [name, state] of this.states) {
			if (!configs.has(name) && state.status !== "disabled") {
				this.hideServerTools(state);
				void this.teardown(state);
				state.status = "disabled";
				state.config = { ...state.config, enabled: false };
				state.error = "removed from configuration";
			}
		}
		this.resourceTools.ensure();
		this.skillTools.ensure();
		this.taskTools.ensure();
		this.ensureReachTools();
	}

	private connectInBackground(state: ServerState): void {
		state.status = "connecting";
		state.error = undefined;
		const p = (async () => {
			await this.teardown(state);
			await this.connect(state);
			this.ensureReachTools();
		})().catch(() => {});
		this.pending.set(state.name, p);
		void p.finally(() => {
			if (this.pending.get(state.name) === p) this.pending.delete(state.name);
		});
	}

	/** Wait for pending connections matching `predicate`, bounded by waitMs (or signal abort). */
	async waitForPending(predicate?: (state: ServerState) => boolean, signal?: AbortSignal): Promise<boolean> {
		const names = [...this.states.values()]
			.filter((s) => s.config.enabled && (predicate ? predicate(s) : true))
			.map((s) => s.name);
		const pending = names
			.map((n) => this.pending.get(n))
			.filter((p): p is Promise<void> => p !== undefined);
		if (pending.length === 0) return true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				Promise.allSettled(pending).then(() => true),
				new Promise<boolean>((resolve) => {
					timer = setTimeout(() => resolve(false), this.waitMs);
					if (signal) {
						onAbort = () => resolve(false);
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	async reconnect(name: string): Promise<ServerState> {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		const p = (async () => {
			await this.teardown(state);
			state.status = "connecting";
			state.error = undefined;
			state.toolCount = 0;
			await this.connect(state);
			this.ensureReachTools();
		})();
		const tracked = p.then(() => undefined, () => undefined);
		this.pending.set(name, tracked);
		try {
			await p;
		} finally {
			if (this.pending.get(name) === tracked) this.pending.delete(name);
		}
		return state;
	}

	/** Reconnect auth-required servers if mcp-oauth.json changed outside this session (e.g. CLI login). */
	async reconnectIfSignedInExternally(): Promise<void> {
		if (!this.credentialStorePath) return;
		const authNeeded = [...this.states.values()].filter((s) => s.config.enabled && s.authRequired);
		if (authNeeded.length === 0) return;
		let mtime: number | undefined;
		try {
			mtime = statSync(this.credentialStorePath).mtimeMs;
		} catch {
			mtime = undefined;
		}
		if (mtime === undefined || mtime === this.lastAuthFileMtimeMs) return;
		this.lastAuthFileMtimeMs = mtime;
		await Promise.allSettled(authNeeded.map((s) => this.reconnect(s.name)));
	}

	/** Interactive OAuth sign-in: arms the consent gate and reconnects. */
	async login(name: string): Promise<ServerState> {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		if (state.config.kind !== "http") {
			throw new Error(`mcp "${name}": OAuth applies to HTTP servers only`);
		}
		if (!this.credentials) throw new Error("OAuth is not available (no credential store)");
		this.loginArmed = name;
		try {
			await this.reconnect(name);
		} finally {
			this.loginArmed = undefined;
		}
		return state;
	}

	/** Delete stored credentials for the server's resource and reconnect. */
	async logout(name: string): Promise<ServerState> {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		if (this.credentials && state.config.url !== undefined) {
			await this.credentials.deleteResource(canonicalResource(state.config.url));
		}
		await this.reconnect(name);
		return state;
	}

	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.pending.values()]);
		await Promise.allSettled([...this.states.values()].map((s) => this.teardown(s)));
		this.states.clear();
		this.pending.clear();
		this.exposureByServer.clear();
		this.toolOwner.clear();
		this.resetSessionState();
	}

	private hideServerTools(state: ServerState): void {
		const hiddenNames = new Set<string>();
		for (const [piName, definition] of state.definitions) {
			hiddenNames.add(piName);
			if (definition.exposure !== "hidden") {
				const next = { ...definition, exposure: "hidden" as const };
				this.pi.registerTool(next);
				state.definitions.set(piName, next);
			}
		}
		state.exposures.clear();
		state.toolCount = 0;
		if (hiddenNames.size > 0) {
			const active = this.pi.getActiveTools();
			if (active.some((n) => hiddenNames.has(n))) {
				this.pi.setActiveTools(active.filter((n) => !hiddenNames.has(n)));
			}
		}
		this.resourceTools.ensure();
		this.skillTools.ensure();
		this.taskTools.ensure();
	}

	private async teardown(state: ServerState): Promise<void> {
		const client = state.client;
		const eventsHandle = state.eventsHandle;
		state.client = undefined;
		state.ops = undefined;
		state.eventsHandle = undefined;
		state.skillsClient = undefined;
		state.skills = undefined;
		this.skillCache.evictServer(state.name);
		state.listenClose?.();
		state.listenClose = undefined;
		state.closeRedirect?.();
		state.closeRedirect = undefined;
		if (eventsHandle) {
			try {
				await eventsHandle.close();
			} catch {
				// best-effort
			}
		}
		if (client) {
			try {
				await client.close({ graceMs: 500 });
			} catch {
				// close is best-effort
			}
		}
	}

	private async buildClient(
		config: ResolvedServerConfig,
		state: ServerState,
	): Promise<{ client: McpClient; eventsExtension?: ReturnType<typeof createEventsExtension> }> {
		let transport: StdioTransport | HttpTransport;
		if (config.kind === "stdio") {
			transport = new StdioTransport({
				command: config.command as string,
				args: config.args ?? [],
				...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
				...(config.env !== undefined ? { env: config.env } : {}),
			});
		} else {
			const headers: Record<string, string> = { ...(config.headers ?? {}) };
			if (config.authProvider && this.providerToken) {
				const token = await this.providerToken(config.authProvider);
				if (token && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
					headers.Authorization = `Bearer ${token}`;
				}
			}
			const hasStaticAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
			let authProvider;
			if (!hasStaticAuth && this.credentials) {
				const handle = await createOAuthProvider({
					config,
					store: this.credentials,
					interactive: () => this.loginArmed === config.name,
					...(this.confirm !== undefined ? { confirm: this.confirm } : {}),
					...(this.browserOpen !== undefined ? { browserOpen: this.browserOpen } : {}),
					allowInsecureAuth: this.allowInsecureAuth,
				});
				authProvider = handle.provider;
				state.closeRedirect = handle.closeRedirect;
			}
			transport = new HttpTransport({
				url: config.url as string,
				...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
				...(authProvider !== undefined ? { authProvider } : {}),
			});
		}
		const client = new McpClient({
			transport,
			server: { key: config.name, label: config.name },
			clientInfo: { name: "pi", version: "pi-adapter" },
			defaults: { timeoutMs: config.timeoutMs },
			ports: { consent: consentPort(this.ui, config.name) },
		});
		client.use(
			createTasksExtension({
				serverKey: config.name,
				request: (method, params, opts) => client.request(method, params, opts),
				peerCapabilities: () => (state.capabilities ?? {}) as Record<string, unknown>,
			}),
		);
		client.use(createSkillsExtension());
		let eventsExtension: ReturnType<typeof createEventsExtension> | undefined;
		if (config.subscribe !== undefined && config.subscribe !== false) {
			eventsExtension = createEventsExtension({ enabled: true, healthy: true });
			client.use(eventsExtension);
		}
		return { client, ...(eventsExtension ? { eventsExtension } : {}) };
	}

	private async connect(state: ServerState): Promise<void> {
		const { config } = state;
		try {
			const { client, eventsExtension } = await this.buildClient(config, state);
			const ops = createOps(client);
			state.client = client;
			state.ops = ops;

			// Best-effort server/discover for capabilities & instructions used as namespace text.
			try {
				const discovered = await client.discover({ timeoutMs: 10_000 });
				if (discovered.kind === "ok") {
					state.capabilities = discovered.value.capabilities as Record<string, unknown>;
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

			if (eventsExtension && config.subscribe !== undefined && config.subscribe !== false) {
				state.eventsHandle = await startPiMcpEvents({
					serverName: state.name,
					subscribe: config.subscribe,
					client,
					extension: eventsExtension,
					peerCapabilities: () => state.capabilities,
					cursors: this.eventCursors,
					seenEventIds: this.seenEventIds,
					deliver: (text, event) => this.deliverPushEvent(text, event, state.config),
				});
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
				// Server without a tools capability (e.g. events/resources-only): valid.
			} else if (isAuthOutcome(listed)) {
				state.authRequired = true;
				if (this.credentialStorePath) {
					try {
						this.lastAuthFileMtimeMs = statSync(this.credentialStorePath).mtimeMs;
					} catch {
						this.lastAuthFileMtimeMs = undefined;
					}
				}
				throw new Error(`authentication required — sign in with /mcp login ${state.name}`);
			} else {
				throw new Error(describeOutcome(listed));
			}
			if (hasSkills({ name: state.name, status: "connected", capabilities: state.capabilities })) {
				state.skillsClient = createServerSkillsClient(
					state.name,
					client,
					state.capabilities,
					this.skillCache,
				);
				const listedSkills = await state.skillsClient.listAll();
				if (listedSkills.kind === "ok") {
					state.skills = listedSkills.value.skills;
				}
			}

			state.status = "connected";
			state.error = undefined;
			state.authRequired = undefined;
			this.exposureByServer.set(state.name, config.exposure);
			this.resourceTools.ensure();
			this.skillTools.ensure();
			this.taskTools.ensure();
			this.startListen(state);
			this.log?.line(state.name, `connected (${state.toolCount} tools)`);
		} catch (err) {
			const wasAuth = state.authRequired === true;
			state.status = "error";
			state.error = err instanceof Error ? err.message : String(err);
			state.authRequired = wasAuth ? true : undefined;
			this.log?.line(state.name, `error: ${state.error}`);
			await this.teardown(state);
			this.notify(`mcp "${state.name}": ${state.error}`, "error");
		}
	}

	private async deliverPushEvent(
		text: string,
		event: McpEvent,
		config: ResolvedServerConfig,
	): Promise<void> {
		if (this.onPushEvent) {
			await this.onPushEvent(text, event, config);
			return;
		}
		this.pi.sendMessage?.(
			{
				customType: "mcp-event",
				content: text,
				display: true,
				details: {
					server: event.server,
					name: event.name,
					eventId: event.eventId,
					timestamp: event.timestamp,
				},
			},
			{
				triggerTurn: true,
				deliverAs: config.eventDelivery ?? "followUp",
			},
		);
	}

	private registerTools(state: ServerState, entries: readonly ToolEntry[]): void {
		const usable = entries.filter((e) => typeof e.name === "string" && e.name !== "");
		const names = assignToolNames(state.name, usable.map((e) => e.name));
		const seen = new Set<string>();
		const demotedFromDirect = new Set<string>();
		state.exposures.clear();

		for (const entry of usable) {
			const piName = names.get(entry.name) as string;
			seen.add(piName);
			this.toolOwner.set(piName, state.name);
			const mcpExposure = toolExposureFor(state.config, entry.name);
			const piExposure = toPiToolExposure(mcpExposure);
			const toolDescription = typeof entry.tool.description === "string" ? entry.tool.description.trim() : "";
			const title =
				typeof (entry.tool as { title?: unknown }).title === "string"
					? ((entry.tool as { title: string }).title)
					: undefined;
			const annotations = annotationsOf(entry);
			const aliases = state.name.includes("-") ? [state.name, state.name.replace(/-/g, "_")] : [state.name];
			const definition: ToolDefinition = {
				name: piName,
				label: `${state.name}/${entry.name}`,
				description: toolDescription || title || `MCP tool ${entry.name} on ${state.name}`,
				parameters: normalizeMcpInputSchema(entry.tool.inputSchema),
				outputSchema: createMcpResultSchema((entry.tool as { outputSchema?: unknown }).outputSchema),
				exposure: piExposure,
				namespace: {
					name: `mcp__${sanitizeNamePart(state.name)}`,
					aliases,
					...(state.description !== undefined ? { description: state.description } : {}),
					...(state.instructions !== undefined ? { instructions: state.instructions } : {}),
				},
				...(annotations !== undefined ? { annotations } : {}),
				promptSnippet: toolDescription.split("\n")[0] ?? "",
				execute: (_id, params, signal, onUpdate) =>
					this.callTool(state.name, entry.name, params, signal, onUpdate),
			};
			const previous = state.definitions.get(piName);
			if (previous?.exposure === "direct" && piExposure !== "direct") {
				demotedFromDirect.add(piName);
			}
			if (
				!previous ||
				JSON.stringify(previous.parameters) !== JSON.stringify(definition.parameters) ||
				JSON.stringify(previous.outputSchema) !== JSON.stringify(definition.outputSchema) ||
				previous.exposure !== piExposure
			) {
				this.pi.registerTool(definition);
			}
			state.definitions.set(piName, definition);
			state.toolNames.set(piName, entry.name);
			state.registeredTools.add(piName);
			state.exposures.add(mcpExposure);
		}
		// Withdrawn tools become unreachable and leave activeTools.
		for (const [piName, definition] of state.definitions) {
			if (!seen.has(piName) && definition.exposure !== "hidden") {
				if (definition.exposure === "direct") demotedFromDirect.add(piName);
				const hiddenDef = { ...definition, exposure: "hidden" as const };
				this.pi.registerTool(hiddenDef);
				state.definitions.set(piName, hiddenDef);
			}
		}
		if (demotedFromDirect.size > 0) {
			this.pi.setActiveTools(this.pi.getActiveTools().filter((n) => !demotedFromDirect.has(n)));
		}
		state.toolCount = seen.size;
	}

	private startListen(state: ServerState): void {
		if (state.listenClose || !state.client) return;
		const toolsCap = state.capabilities?.tools as { listChanged?: boolean } | undefined;
		if (toolsCap?.listChanged !== true) return;
		const stream = state.client.openStream("subscriptions/listen", {
			notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
		});
		state.listenClose = () => stream.close();
		void (async () => {
			try {
				for await (const notification of stream) {
					if (notification.method === "notifications/tools/list_changed") {
						await this.refreshTools(state);
					} else if (notification.method === "notifications/resources/list_changed" && state.skillsClient) {
						const refreshed = await state.skillsClient.listAll();
						if (refreshed.kind === "ok") state.skills = refreshed.value.skills;
					}
				}
			} catch {
				// listen stream ended; reconnect re-establishes it
			}
		})();
	}

	private async refreshTools(state: ServerState): Promise<void> {
		if (!state.ops) return;
		const listed = await state.ops.tools.listAll({ maxItems: 10_000 });
		if (listed.kind !== "ok") return;
		this.registerTools(state, listed.value.items);
		this.ensureReachTools();
		this.log?.line(state.name, `tools/list_changed (${state.toolCount} tools)`);
	}

	private async callTool(
		serverName: string,
		toolName: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: ToolResult) => void) | undefined,
	): Promise<ToolResult> {
		let state = this.states.get(serverName);
		if (state && !state.config.enabled) {
			throw new Error(`MCP server "${serverName}" is disabled.`);
		}
		if (!state?.ops || state.status !== "connected") {
			throw new Error(
				`MCP server "${serverName}" is not connected (status: ${state?.status ?? "closed"}${
					state?.error ? `, ${state.error}` : ""
				}). Run /mcp reconnect ${serverName}.`,
			);
		}
		if (toolExposureFor(state.config, toolName) === "hidden") {
			throw new Error(`MCP tool "${serverName}/${toolName}" is hidden.`);
		}
		const progress = (p: unknown) => {
			const rec = p as { message?: unknown; progress?: unknown; total?: unknown } | undefined;
			if (!onUpdate || !rec) return;
			const msg =
				typeof rec.message === "string"
					? `${serverName}/${toolName}: ${rec.message}`
					: rec.progress !== undefined
						? `${serverName}/${toolName}: Progress ${String(rec.progress)}${rec.total !== undefined ? `/${String(rec.total)}` : ""}`
						: undefined;
			if (msg !== undefined) {
				onUpdate({
					content: [{ type: "text", text: msg }],
					details: { server: serverName, tool: toolName },
				});
			}
		};
		let outcome = await callWithElicitation(
			state,
			toolName,
			params,
			{
				...(signal !== undefined ? { signal } : {}),
				onProgress: progress,
			},
			this.ui,
		);
		if (
			outcome.kind === "transport-failure" &&
			RETRY_KINDS.has(outcome.failure.kind) &&
			!(signal?.aborted ?? false)
		) {
			try {
				state = await this.reconnect(serverName);
			} catch {
				// fall through to reporting the original outcome
			}
			if (state.ops && state.status === "connected") {
				outcome = await callWithElicitation(
					state,
					toolName,
					params,
					{
						...(signal !== undefined ? { signal } : {}),
					},
					this.ui,
				);
			}
		}
		if (outcome.kind === "task-handle") return taskHandleResult(state, toolName, outcome);
		return this.outcomeToResult(serverName, toolName, outcome);
	}

	private async outcomeToResult(
		serverName: string,
		toolName: string,
		outcome: Outcome<ToolCallResult>,
	): Promise<ToolResult> {
		const details = { server: serverName, tool: toolName };
		if (outcome.kind === "ok") {
			const { value } = outcome;
			const wireContent = value.content.map(stripWireBlockMeta);
			const scriptResult: Record<string, unknown> = {
				content: wireContent,
				...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
			};
			return {
				content: await convertBlocksOffloaded(value.content),
				details: { ...details, validation: value.validation.status },
				structuredContent: scriptResult,
			};
		}
		if (outcome.kind === "tool-isError") {
			const raw = outcome.result;
			const normalized = normalizeContent(raw.content);
			const wireContent = normalized.map(stripWireBlockMeta);
			const converted =
				normalized.length === 0
					? [{ type: "text" as const, text: `MCP tool ${serverName}/${toolName} returned an error` }]
					: await convertBlocksOffloaded(normalized);
			const hasNonEmptyText = converted.some((b) => b.type !== "text" || b.text.trim() !== "");
			const finalContent = hasNonEmptyText
				? converted
				: [{ type: "text" as const, text: `MCP tool ${serverName}/${toolName} returned an error` }];
			return {
				content: finalContent,
				details,
				isError: true,
				structuredContent: {
					content: wireContent,
					...(raw.structuredContent !== undefined ? { structuredContent: raw.structuredContent } : {}),
					isError: true,
				},
			};
		}
		throw new Error(`mcp ${serverName}/${toolName}: ${describeOutcome(outcome)}`);
	}

	/** Prompt list for /mcp prompts. */
	async promptsList(name: string): Promise<unknown[]> {
		const state = this.states.get(name);
		if (!state?.ops) throw new Error(`MCP server "${name}" is not connected`);
		const outcome = await state.ops.prompts.listAll();
		if (outcome.kind !== "ok") throw new Error(`prompts/list failed: ${outcome.kind}`);
		return outcome.value.items;
	}

	/** Prompt get for /mcp prompt. */
	async promptGet(name: string, prompt: string, args: Record<string, string>): Promise<unknown> {
		const state = this.states.get(name);
		if (!state?.ops) throw new Error(`MCP server "${name}" is not connected`);
		const outcome = await state.ops.prompts.get(prompt, args);
		if (outcome.kind !== "ok") throw new Error(`prompts/get failed: ${outcome.kind}`);
		return outcome.value;
	}

	async resourcesList(name: string): Promise<unknown[]> {
		const state = this.states.get(name);
		if (!state?.ops) throw new Error(`MCP server "${name}" is not connected`);
		const outcome = await state.ops.resources.listAll();
		if (outcome.kind !== "ok") throw new Error(`resources/list failed: ${outcome.kind}`);
		return outcome.value.items.map((item: { raw: Record<string, unknown> }) => item.raw);
	}

	eventsStatus(name: string): { advertised: readonly string[]; subscribed: readonly string[] } {
		const state = this.states.get(name);
		if (!state || state.status !== "connected") throw new Error(`MCP server "${name}" is not connected`);
		return {
			advertised: state.eventsHandle?.advertised ?? [],
			subscribed: state.eventsHandle?.subscribed ?? [],
		};
	}

	async taskState(name: string, taskId: string, cancel = false): Promise<unknown> {
		const state = this.states.get(name);
		if (!state?.ops) throw new Error(`MCP server "${name}" is not connected`);
		return cancel ? cancelTask(state, taskId) : getTask(state, taskId);
	}

	async skillsList(name: string): Promise<readonly SkillEntry[]> {
		const state = this.states.get(name);
		if (!state?.skillsClient) throw new Error(`MCP server "${name}" does not advertise io.modelcontextprotocol/skills`);
		const out = await state.skillsClient.listAll();
		if (out.kind !== "ok") throw new Error(`skills/list failed: ${out.kind}`);
		state.skills = out.value.skills;
		return out.value.skills;
	}

	async skillRead(name: string, uri: string): Promise<string> {
		const state = this.states.get(name);
		if (!state?.skillsClient) throw new Error(`MCP server "${name}" does not advertise io.modelcontextprotocol/skills`);
		if (!state.skillsClient.isKnownSkill(uri)) {
			const got = await state.skillsClient.get(uri);
			if (got.kind !== "ok") throw new Error(`skills/get failed: ${got.kind}`);
		}
		const read = await state.skillsClient.readFile(uri, uri);
		if (read.kind !== "ok") throw new Error(`skill read failed: ${read.kind}`);
		return formatOriginTaggedSkill(name, uri, uri, read.value.text);
	}

	/** Session-only enable/disable; persistence is handled by the command layer. */
	setEnabled(name: string, enabled: boolean): void {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		state.config = { ...state.config, enabled };
		if (!enabled) {
			this.hideServerTools(state);
			void this.teardown(state);
			state.status = "disabled";
		} else {
			this.connectInBackground(state);
			this.ensureReachTools();
		}
	}

	/** Session-only exposure change; re-registers affected tools and cleans activeTools. */
	setExposure(name: string, exposure: Exposure, toolPattern?: string): void {
		const state = this.states.get(name);
		if (!state) throw new Error(`unknown server: ${name}`);
		state.config = toolPattern
			? { ...state.config, toolExposure: { ...state.config.toolExposure, [toolPattern]: exposure } }
			: { ...state.config, exposure };
		this.exposureByServer.set(name, state.config.exposure);
		const demotedFromDirect = new Set<string>();
		state.exposures.clear();
		for (const [piName, definition] of state.definitions) {
			const serverTool = state.toolNames.get(piName) as string;
			const nextMcp = toolExposureFor(state.config, serverTool);
			const nextPi = toPiToolExposure(nextMcp);
			state.exposures.add(nextMcp);
			if (definition.exposure !== nextPi) {
				if (definition.exposure === "direct" && nextPi !== "direct") {
					demotedFromDirect.add(piName);
				}
				const updated = { ...definition, exposure: nextPi };
				this.pi.registerTool(updated);
				state.definitions.set(piName, updated);
			}
		}
		if (demotedFromDirect.size > 0) {
			this.pi.setActiveTools(this.pi.getActiveTools().filter((n) => !demotedFromDirect.has(n)));
		}
		this.resourceTools.ensure();
		this.skillTools.ensure();
		this.taskTools.ensure();
		this.ensureReachTools();
	}

	/**
	 * Mirror Pi's built-in ensureDiscoveryActive:
	 * Activates `codemode` or `tool_search` from configured & connected exposures
	 * before servers even finish connecting, honors `autoEnableCodemode` from mcp.json,
	 * checks `reachesTools` when available, and warns once if indirect tools are unreachable.
	 */
	ensureReachTools(): void {
		const exposures = new Set<Exposure>();
		for (const s of this.states.values()) {
			if (!s.config.enabled) continue;
			for (const e of configuredExposuresOf(s.config)) exposures.add(e);
			if (s.status === "connected") {
				for (const e of s.exposures) exposures.add(e);
			}
		}
		const needsCodemode = exposures.has("codemode");
		const needsToolSearch = exposures.has("deferred");
		if (!needsCodemode && !needsToolSearch) return;

		const settingsAuto = this.pi.getSettings?.()?.autoEnableCodemode;
		const autoEnable =
			this.autoEnableCodemodeOverride !== undefined
				? this.autoEnableCodemodeOverride
				: settingsAuto !== false;

		const all = this.pi.getAllTools();
		const canReach = (name: string) =>
			all.some((t) => t.name === name && (t.reachesTools === undefined || Boolean(t.reachesTools)));
		const hasCodemode = canReach("codemode");
		const hasToolSearch = canReach("tool_search");

		const active = new Set(this.pi.getActiveTools());
		const toAdd: string[] = [];
		if (needsCodemode && hasCodemode && autoEnable && !active.has("codemode")) {
			toAdd.push("codemode");
		}
		if (needsToolSearch && hasToolSearch && !active.has("tool_search")) {
			toAdd.push("tool_search");
		}
		if (toAdd.length > 0) this.pi.setActiveTools([...active, ...toAdd]);

		const reachable = new Set([...active, ...toAdd]);
		if ((hasCodemode && reachable.has("codemode")) || (hasToolSearch && reachable.has("tool_search"))) {
			return;
		}
		// Only warn when a real host declared codemode/tool_search or autoEnableCodemode disabled it.
		if (!this.warnedUnreachable && (hasCodemode || hasToolSearch)) {
			this.warnedUnreachable = true;
			const reason = needsCodemode && hasCodemode && !autoEnable ? " (autoEnableCodemode is false)" : "";
			this.notify(
				`MCP tools are only reachable from the codemode or tool_search tool, but neither is active${reason}; they cannot be called.`,
				"warning",
			);
		}
	}

	statusLines(extraNotices: readonly string[] = []): string[] {
		if (this.states.size === 0 && extraNotices.length === 0) return ["No MCP servers configured."];
		const lines = [...this.states.values()].map((s) => {
			const base = `${s.name} (${s.config.kind}, ${s.config.source}, ${s.config.exposure})`;
			const subs =
				s.eventsHandle && s.eventsHandle.subscribed.length > 0
					? `, events: ${s.eventsHandle.subscribed.join(",")}`
					: "";
			switch (s.status) {
				case "connected":
					return `${base}: connected, ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}${subs}`;
				case "connecting":
					return `${base}: connecting…`;
				case "disabled":
					return `${base}: disabled${s.error ? ` (${s.error})` : ""}`;
				case "error":
					return s.authRequired
						? `${base}: needs sign-in — /mcp login ${s.name}`
						: `${base}: error: ${s.error ?? "unknown"}`;
			}
		});
		for (const notice of extraNotices) lines.push(notice);
		return lines;
	}
}
