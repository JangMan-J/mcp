/**
 * Minimal structural types for the Pi extension API surface this bridge uses.
 *
 * This package deliberately does not depend on @earendil-works/pi-coding-agent
 * (see scripts/check-forbidden.mjs): Pi injects its own copies of host packages
 * at runtime, and the factory receives everything through the `pi` argument.
 * The declarations below cover only what the bridge touches. If Pi widens its
 * API, these stay valid; if Pi narrows it, jiti will fail loudly at load.
 */

export type PiContent =
	| { type: "text"; text: string }
	| { type: "image"; data: string; mimeType: string };

export interface ToolResult {
	content: PiContent[];
	details?: unknown;
	isError?: boolean;
	structuredContent?: unknown;
}

export type ToolExposure = "direct" | "model-only" | "codemode" | "deferred" | "hidden";

export interface ToolAnnotations {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

export interface ToolNamespace {
	name: string;
	aliases?: string[];
	description?: string;
	instructions?: string;
}

export type OnUpdate = (partial: ToolResult) => void;

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	exposure?: ToolExposure;
	namespace?: ToolNamespace;
	annotations?: ToolAnnotations;
	promptSnippet?: string;
	execute(
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: OnUpdate | undefined,
		ctx: unknown,
	): Promise<ToolResult>;
}

/** Shape of one `mcpServers` entry in mcp.json / pi.registerMcpServer(). */
export interface McpServerEntry {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	oauth?: Record<string, unknown>;
	enabled?: boolean;
	exposure?: string;
	toolExposure?: Record<string, string>;
	description?: string;
	timeout?: number;
}

export interface Ui {
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface SessionContext {
	cwd: string;
	hasUI: boolean;
	isProjectTrusted(): boolean;
	ui: Ui;
}

export interface CommandContext {
	ui: Ui;
}

export interface ToolInfo {
	name: string;
	exposure?: string;
}

export interface SystemPromptOptions {
	sections?: Record<string, string>;
}

export interface BeforeAgentStartEvent {
	systemPromptOptions?: SystemPromptOptions;
}

export interface ToolCallEvent {
	toolName: string;
}

export interface McpServersChangeEvent {
	servers: unknown;
}

export interface CommandDefinition {
	description: string;
	handler(args: string, ctx: CommandContext): Promise<void> | void;
}

export interface ExtensionAPI {
	on(event: "session_start", handler: (event: { reason?: string }, ctx: SessionContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: { reason?: string }, ctx: SessionContext) => unknown): void;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: SessionContext) => unknown): void;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: SessionContext) => unknown): void;
	on(event: "mcp_servers_change", handler: (event: McpServersChangeEvent, ctx: SessionContext) => unknown): void;
	registerTool(definition: ToolDefinition): void;
	registerCommand(name: string, definition: CommandDefinition): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	getAllTools(): ToolInfo[];
	getMcpServers(): unknown;
	getSettings?(): Record<string, unknown>;
}
