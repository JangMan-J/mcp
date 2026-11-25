import type { JsonRpcNotification, JsonRpcRequest, RequestId } from "@mcp-client/core";
import { createBuiltinValidator, type SchemaValidator, type ValidationResult } from "@mcp-client/ops";
import {
	EventsServer,
	ServerError,
	SubscriptionsServer,
	TaskCenter,
	type Obj,
} from "@mcp-client/server-events";
import { complete, DEFAULT_CACHE_HINTS, paginate, PROTOCOL_VERSION, validateRequestMeta, type CacheHints } from "./protocol.js";
import { matchUriTemplate } from "./uri.js";
import { SkillsRegistry, type SkillInput } from "./skills.js";

export interface ToolDefinition {
	readonly name: string;
	readonly description?: string;
	readonly inputSchema?: Obj;
	readonly outputSchema?: Obj;
	readonly annotations?: Obj;
	readonly handler: (args: unknown, ctx: { readonly signal: AbortSignal; readonly requestId: RequestId }) => unknown | Promise<unknown>;
}

export interface ResourceDefinition {
	readonly uri: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly handler: () => unknown | Promise<unknown>;
}

export interface ResourceTemplateDefinition {
	readonly uriTemplate: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
	readonly handler: (uri: string, vars: Record<string, string>) => unknown | Promise<unknown>;
}

export interface PromptDefinition {
	readonly name: string;
	readonly description?: string;
	readonly arguments?: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly required?: boolean }>;
	readonly handler: (args: Record<string, string>) => unknown | Promise<unknown>;
}

export type CompletionHandler = (input: {
	readonly ref: Obj;
	readonly argument: { readonly name: string; readonly value: string };
	readonly context?: Obj;
}) => { readonly values: string[]; readonly total?: number; readonly hasMore?: boolean } | Promise<{ readonly values: string[]; readonly total?: number; readonly hasMore?: boolean }>;

export interface McpServerOptions {
	readonly serverInfo: { readonly name: string; readonly version: string; readonly title?: string };
	readonly instructions?: string;
	readonly supportedVersions?: readonly string[];
	readonly cache?: CacheHints;
	readonly pageSize?: number;
	readonly validator?: SchemaValidator;
	readonly subscriptions?: SubscriptionsServer;
	readonly events?: EventsServer;
	readonly tasks?: TaskCenter;
	readonly skills?: SkillsRegistry;
	readonly onComplete?: CompletionHandler;
}

/** Wrap a TaskCenter state as a task-handle result (resultType "task"). */
export function taskResult(state: Obj): Obj {
	return { resultType: "task", ...state };
}

/**
 * Transport-agnostic MCP 2026-07-28 server for the ordinary request surface:
 * server/discover, tools, resources/templates, prompts, and completion.
 * Push streams live in @mcp-client/server-events; the host owns JSON-RPC
 * dispatch, error mapping, and transports.
 */
export class McpServer {
	readonly #options: McpServerOptions;
	readonly #validator: SchemaValidator;
	readonly #tools = new Map<string, ToolDefinition>();
	readonly #resources = new Map<string, ResourceDefinition>();
	readonly #templates = new Map<string, ResourceTemplateDefinition>();
	readonly #prompts = new Map<string, PromptDefinition>();
	readonly #compiled = new Map<string, ReturnType<SchemaValidator["compile"]>>();
	readonly #versions: readonly string[];
	readonly #inFlight = new Map<RequestId, AbortController>();
	readonly #cancelled = new Set<RequestId>();

	constructor(options: McpServerOptions) {
		this.#options = options;
		this.#validator = options.validator ?? createBuiltinValidator();
		this.#versions = options.supportedVersions ?? [PROTOCOL_VERSION];
	}

	registerTool(def: ToolDefinition): this {
		if (!def.name) throw new ServerError(-32602, "tool name required");
		const schema = def.inputSchema ?? { type: "object", properties: {} };
		if (schema.type !== "object") throw new ServerError(-32602, `tool ${def.name}: inputSchema must be type object`);
		this.#compiled.set(def.name, this.#validator.compile(schema));
		this.#tools.set(def.name, def);
		this.#options.subscriptions?.notifyToolsChanged();
		return this;
	}

	registerResource(def: ResourceDefinition): this {
		this.#resources.set(def.uri, def);
		this.#options.subscriptions?.notifyResourcesChanged();
		return this;
	}

	registerResourceTemplate(def: ResourceTemplateDefinition): this {
		this.#templates.set(def.uriTemplate, def);
		this.#options.subscriptions?.notifyResourcesChanged();
		return this;
	}

	registerPrompt(def: PromptDefinition): this {
		this.#prompts.set(def.name, def);
		this.#options.subscriptions?.notifyPromptsChanged();
		return this;
	}

	get events(): EventsServer | undefined {
		return this.#options.events;
	}

	get subscriptions(): SubscriptionsServer | undefined {
		return this.#options.subscriptions;
	}

	get tasks(): TaskCenter | undefined {
		return this.#options.tasks;
	}

	get skills(): SkillsRegistry | undefined {
		return this.#options.skills;
	}

	registerSkill(input: SkillInput): this {
		const registry = this.#options.skills ?? new SkillsRegistry();
		registry.register(input);
		(this.#options as { skills?: SkillsRegistry }).skills = registry;
		return this;
	}

	capabilities(): Obj {
		const caps: Obj = {};
		const listChanged = this.#options.subscriptions !== undefined;
		if (this.#tools.size > 0) caps.tools = listChanged ? { listChanged: true } : {};
		if (this.#resources.size > 0 || this.#templates.size > 0 || this.#options.skills !== undefined) {
			caps.resources = listChanged ? { listChanged: true, subscribe: true } : {};
		}
		if (this.#prompts.size > 0) caps.prompts = listChanged ? { listChanged: true } : {};
		if (this.#options.onComplete) caps.completions = {};
		const extensions = {
			...(this.#options.events?.capabilities().extensions as Obj | undefined),
			...(this.#options.tasks?.capabilities().extensions as Obj | undefined),
			...(this.#options.skills?.capabilities().extensions as Obj | undefined),
		};
		if (Object.keys(extensions).length > 0) caps.extensions = extensions;
		return caps;
	}

	discover(): Obj {
		return complete({
			supportedVersions: [...this.#versions],
			capabilities: this.capabilities(),
			serverInfo: this.#options.serverInfo,
			...(this.#options.instructions !== undefined ? { instructions: this.#options.instructions } : {}),
		}, this.#options.cache ?? DEFAULT_CACHE_HINTS);
	}

	/** Handle notifications/cancelled: aborts the in-flight request, if any. */
	handleNotification(msg: JsonRpcNotification): void {
		if (msg.method !== "notifications/cancelled") return;
		const requestId = (msg.params as Obj | undefined)?.requestId;
		if (typeof requestId === "string" || typeof requestId === "number") this.cancel(requestId);
	}

	/** Abort an in-flight request. The host should suppress its response. */
	cancel(requestId: RequestId): void {
		this.#cancelled.add(requestId);
		this.#inFlight.get(requestId)?.abort();
	}

	wasCancelled(requestId: RequestId): boolean {
		return this.#cancelled.has(requestId);
	}
	/** Handle one ordinary JSON-RPC request; throws ServerError for the host to map. */
	async handleRequest(msg: JsonRpcRequest): Promise<Obj> {
		const ac = new AbortController();
		this.#inFlight.set(msg.id, ac);
		if (this.#cancelled.has(msg.id)) ac.abort();
		try {
			return await this.#handleRequest(msg, ac.signal);
		} finally {
			this.#inFlight.delete(msg.id);
		}
	}

	async #handleRequest(msg: JsonRpcRequest, signal: AbortSignal): Promise<Obj> {
		const params = (msg.params ?? {}) as Obj;
		validateRequestMeta(params, this.#versions);
		switch (msg.method) {
			case "server/discover":
				return this.discover();
			case "tools/list": {
				const tools = [...this.#tools.values()].sort((a, b) => a.name.localeCompare(b.name));
				const page = paginate(tools, params.cursor, this.#options.pageSize);
				return complete({
					tools: page.items.map((tool) => this.#toolSchema(tool)),
					...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
				}, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
			case "tools/call":
				return this.#callTool(params, msg.id, signal);
			case "resources/list": {
				const resources = [...this.#resources.values()].sort((a, b) => a.uri.localeCompare(b.uri));
				const page = paginate(resources, params.cursor, this.#options.pageSize);
				return complete({
					resources: page.items.map((r) => this.#resourceSchema(r)),
					...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
				}, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
			case "resources/templates/list": {
				const templates = [...this.#templates.values()].sort((a, b) => a.uriTemplate.localeCompare(b.uriTemplate));
				const page = paginate(templates, params.cursor, this.#options.pageSize);
				return complete({
					resourceTemplates: page.items.map((t) => ({
						uriTemplate: t.uriTemplate,
						name: t.name,
						...(t.description !== undefined ? { description: t.description } : {}),
						...(t.mimeType !== undefined ? { mimeType: t.mimeType } : {}),
					})),
					...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
				}, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
			case "resources/read":
				return this.#readResource(params);
			case "prompts/list": {
				const prompts = [...this.#prompts.values()].sort((a, b) => a.name.localeCompare(b.name));
				const page = paginate(prompts, params.cursor, this.#options.pageSize);
				return complete({
					prompts: page.items.map((p) => ({
						name: p.name,
						...(p.description !== undefined ? { description: p.description } : {}),
						...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
					})),
					...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
				}, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
			case "prompts/get":
				return this.#getPrompt(params);
			case "completion/complete":
				return this.#complete(params);
			case "events/list":
				return this.#events().list();
			case "events/poll":
				return this.#events().poll(params);
			case "tasks/get":
				return this.#tasks().get(params);
			case "tasks/cancel":
				return this.#tasks().cancel(params);
			case "tasks/update":
				return this.#tasks().update(params);
			case "skills/list":
				return this.#skills().list(params.cursor, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			case "skills/get": {
				if (typeof params.uri !== "string") throw new ServerError(-32602, "skill uri required");
				return this.#skills().get(params.uri, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
			case "subscriptions/listen":
			case "events/stream":
				throw new ServerError(-32601, `${msg.method} requires a PushChannel from the host transport`);
			default:
				throw new ServerError(-32601, `method not found: ${msg.method}`);
		}
	}

	#events(): EventsServer {
		if (!this.#options.events) throw new ServerError(-32601, "events extension unavailable");
		return this.#options.events;
	}
	#tasks(): TaskCenter {
		if (!this.#options.tasks) throw new ServerError(-32601, "tasks extension unavailable");
		return this.#options.tasks;
	}

	#skills(): SkillsRegistry {
		if (!this.#options.skills) throw new ServerError(-32601, "skills extension unavailable");
		return this.#options.skills;
	}

	#toolSchema(tool: ToolDefinition): Obj {
		return {
			name: tool.name,
			...(tool.description !== undefined ? { description: tool.description } : {}),
			inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
			...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
			...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
		};
	}

	/** Public schema view for transports validating Mcp-Param-* headers. */
	toolSchema(name: string): Obj | undefined {
		const tool = this.#tools.get(name);
		return tool ? this.#toolSchema(tool) : undefined;
	}

	#resourceSchema(resource: ResourceDefinition): Obj {
		return {
			uri: resource.uri,
			name: resource.name,
			...(resource.description !== undefined ? { description: resource.description } : {}),
			...(resource.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
		};
	}

	async #callTool(params: Obj, requestId: RequestId, signal: AbortSignal): Promise<Obj> {
		const name = params.name;
		if (typeof name !== "string") throw new ServerError(-32602, "tool name required");
		const tool = this.#tools.get(name);
		if (!tool) throw new ServerError(-32602, `unknown tool: ${name}`);
		const compiled = this.#compiled.get(name);
		if (compiled && !compiled.ok) throw new ServerError(-32603, `tool ${name}: ${compiled.message}`);
		const args = params.arguments ?? {};
		if (compiled?.ok) {
			const verdict: ValidationResult = compiled.validate(args);
			if (!verdict.valid) throw new ServerError(-32602, `invalid tool arguments: ${verdict.errors[0]?.message ?? "schema mismatch"}`, { issues: verdict.errors });
		}
		let returned: unknown;
		try {
			if (signal.aborted) throw new ServerError(-32800, "request cancelled");
			returned = await tool.handler(args, { signal, requestId });
			if (signal.aborted) throw new ServerError(-32800, "request cancelled");
		} catch (error) {
			if (error instanceof ServerError) throw error;
			if (signal.aborted) throw new ServerError(-32800, "request cancelled");
			return complete({
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				isError: true,
			});
		}
		if (typeof returned === "object" && returned !== null && "resultType" in returned) return returned as Obj;
		const result = normalizeToolResult(returned);
		if (tool.outputSchema && result.structuredContent !== undefined) {
			const output = this.#validator.compile(tool.outputSchema);
			if (!output.ok) throw new ServerError(-32603, `tool ${name}: ${output.message}`);
			const verdict = output.validate(result.structuredContent);
			if (!verdict.valid) throw new ServerError(-32603, `tool ${name}: output does not match outputSchema`, { issues: verdict.errors });
		}
		return complete(result);
	}

	async #readResource(params: Obj): Promise<Obj> {
		const uri = params.uri;
		if (typeof uri !== "string") throw new ServerError(-32602, "resource uri required");
		const exact = this.#resources.get(uri);
		if (exact) {
			return complete({ contents: await resourceContents(uri, exact.mimeType, await exact.handler()) }, this.#options.cache ?? DEFAULT_CACHE_HINTS);
		}
		for (const template of this.#templates.values()) {
			const vars = matchUriTemplate(template.uriTemplate, uri);
			if (vars) {
				return complete({ contents: await resourceContents(uri, template.mimeType, await template.handler(uri, vars)) }, this.#options.cache ?? DEFAULT_CACHE_HINTS);
			}
		}
		const skillFile = this.#options.skills?.read(uri);
		if (skillFile) return complete({ contents: [skillFile] }, this.#options.cache ?? DEFAULT_CACHE_HINTS);
		throw new ServerError(-32602, `resource not found: ${uri}`);
	}

	async #getPrompt(params: Obj): Promise<Obj> {
		const name = params.name;
		if (typeof name !== "string") throw new ServerError(-32602, "prompt name required");
		const prompt = this.#prompts.get(name);
		if (!prompt) throw new ServerError(-32602, `unknown prompt: ${name}`);
		const args = params.arguments ?? {};
		if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ServerError(-32602, "prompt arguments must be an object");
		for (const arg of prompt.arguments ?? []) {
			if (arg.required === true && typeof (args as Obj)[arg.name] !== "string") {
				throw new ServerError(-32602, `missing required prompt argument: ${arg.name}`);
			}
		}
		const returned = await prompt.handler(args as Record<string, string>);
		const result = Array.isArray(returned) ? { messages: returned } : returned;
		if (typeof result !== "object" || result === null || !Array.isArray((result as Obj).messages)) {
			throw new ServerError(-32603, `prompt ${name}: handler must return messages`);
		}
		return complete(result as Obj);
	}

	async #complete(params: Obj): Promise<Obj> {
		const handler = this.#options.onComplete;
		if (!handler) throw new ServerError(-32601, "completion unavailable");
		const argument = params.argument;
		if (typeof argument !== "object" || argument === null || typeof (argument as Obj).name !== "string" || typeof (argument as Obj).value !== "string") {
			throw new ServerError(-32602, "completion argument.name/value required");
		}
		const ref = params.ref;
		if (typeof ref !== "object" || ref === null) throw new ServerError(-32602, "completion ref required");
		const result = await handler({
			ref: ref as Obj,
			argument: argument as { name: string; value: string },
			...(params.context !== undefined ? { context: params.context as Obj } : {}),
		});
		const values = result.values.slice(0, 100);
		return complete({
			completion: {
				values,
				...(result.total !== undefined ? { total: result.total } : {}),
				...(result.hasMore !== undefined || result.values.length > 100 ? { hasMore: result.hasMore ?? true } : {}),
			},
		});
	}
}

function normalizeToolResult(returned: unknown): Obj {
	if (typeof returned === "object" && returned !== null && Array.isArray((returned as Obj).content)) return returned as Obj;
	return { content: [{ type: "text", text: typeof returned === "string" ? returned : JSON.stringify(returned) }] };
}

async function resourceContents(uri: string, mimeType: string | undefined, returned: unknown): Promise<Obj[]> {
	const entries = Array.isArray(returned) ? returned : [returned];
	return entries.map((entry) => {
		if (typeof entry === "string") return { uri, text: entry, ...(mimeType !== undefined ? { mimeType } : {}) };
		if (typeof entry !== "object" || entry === null) throw new ServerError(-32603, "resource handler returned invalid contents");
		const obj = entry as Obj;
		const hasText = "text" in obj;
		const hasBlob = "blob" in obj;
		if (hasText === hasBlob) throw new ServerError(-32603, "resource contents need exactly one of text/blob");
		return { uri, ...obj, ...(mimeType !== undefined && obj.mimeType === undefined ? { mimeType } : {}) };
	});
}
