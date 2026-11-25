/**
 * Minimal structural types for the Pi extension API surface this bridge uses.
 *
 * This package deliberately does not depend on @earendil-works/pi-coding-agent
 * (see scripts/check-deps.mjs): Pi injects its own copies of host packages
 * at runtime, and the factory receives everything through the `pi` argument.
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
	aliases?: readonly string[];
	description?: string;
	instructions?: string;
}

export type OnUpdate = (partial: ToolResult) => void;

export interface ToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
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

export interface McpSubscriptionSpecEntry {
	readonly name: string;
	readonly arguments?: Record<string, unknown>;
	readonly holdSettle?: boolean;
	readonly maxAgeMs?: number;
	readonly heartbeatMs?: number;
}

export type EventDeliveryMode = "followUp" | "steer" | "nextTurn";

/** Shape of one `mcpServers` entry in mcp.json / pi.registerMcpServer(). */
export interface McpServerEntry {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: { provider?: string };
	oauth?: Record<string, unknown>;
	enabled?: boolean;
	exposure?: string;
	toolExposure?: Record<string, string>;
	subscribe?: boolean | readonly (string | McpSubscriptionSpecEntry)[];
	eventDelivery?: EventDeliveryMode;
	description?: string;
	timeout?: number;
}

export interface Ui {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	confirm?(title: string, message: string): Promise<boolean>;
	input?(title: string, placeholder?: string): Promise<string | undefined>;
	select?(title: string, options: string[]): Promise<string | undefined>;
}

export interface ModelRegistryLike {
	getApiKeyForProvider?(provider: string): Promise<string | undefined> | string | undefined;
}

export interface SessionContext {
	cwd: string;
	hasUI: boolean;
	isProjectTrusted(): boolean;
	modelRegistry?: ModelRegistryLike;
	ui: Ui;
}

export interface CommandContext {
	readonly cwd?: string;
	ui: Ui;
}

export interface ToolInfo {
	name: string;
	exposure?: string;
	reachesTools?: (input: unknown) => "all" | readonly string[];
}

export interface SystemPromptOptions {
	sections?: Record<string, string>;
}

export interface BeforeAgentStartEvent {
	systemPromptOptions?: SystemPromptOptions;
}

export interface ToolCallEvent {
	toolName: string;
	input?: unknown;
}

export interface McpServersChangeEvent {
	servers: unknown;
}

export interface CommandDefinition {
	description: string;
	handler(args: string, ctx: CommandContext): Promise<void> | void;
}

export interface CustomMessagePayload<T = unknown> {
	customType: string;
	content: string | PiContent[];
	display?: boolean;
	details?: T;
}

export interface SendMessageOptions {
	triggerTurn?: boolean;
	deliverAs?: EventDeliveryMode;
}

export interface ExtensionAPI {
	on(event: "session_start", handler: (event: { reason?: string }, ctx: SessionContext) => unknown): void;
	on(event: "session_shutdown", handler: (event: { reason?: string }, ctx: SessionContext) => unknown): void;
	on(event: "before_agent_start", handler: (event: BeforeAgentStartEvent, ctx: SessionContext) => unknown): void;
	on(event: "turn_start", handler: (event: unknown, ctx: SessionContext) => unknown): void;
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: SessionContext) => unknown): void;
	on(event: "mcp_servers_change", handler: (event: McpServersChangeEvent, ctx: SessionContext) => unknown): void;
	registerTool(definition: ToolDefinition): void;
	registerCommand(name: string, definition: CommandDefinition): void;
	sendMessage?<T = unknown>(message: CustomMessagePayload<T>, options?: SendMessageOptions): void;
	appendEntry?<T = unknown>(customType: string, data?: T): void;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	getAllTools(): ToolInfo[];
	getMcpServers(): unknown;
	getSettings?(): Record<string, unknown>;
}
