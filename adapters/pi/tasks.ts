/** SEP-2663 Task-based tool-call results, model tools, and /mcp task helpers. */

import type { McpClient, Outcome } from "@jangmanj/mcp/core";
import { TASKS_ID, TasksRuntime, type TaskState } from "@jangmanj/mcp/mrtr-cache";
import type { ToolCallResult } from "@jangmanj/mcp/ops";
import type { Exposure } from "./config.ts";
import type { ExtensionAPI, ToolExposure, ToolResult } from "./pi-api.ts";
import type { ResourceServer } from "./resources.ts";

export const TASK_TOOL_NAMES = [
	"get_mcp_task",
	"cancel_mcp_task",
	"update_mcp_task",
] as const;

export function hasTasks(state: ResourceServer): boolean {
	const exts = state.capabilities?.extensions;
	if (!exts || typeof exts !== "object" || Array.isArray(exts)) return false;
	const t = (exts as Record<string, unknown>)[TASKS_ID];
	return typeof t === "object" && t !== null && !Array.isArray(t);
}

function exposureRank(e: Exposure): number {
	return e === "direct" ? 3 : e === "codemode" ? 2 : e === "deferred" ? 1 : 0;
}

function toPiExposure(e: Exposure): ToolExposure {
	return e === "codemode" ? "deferred" : e;
}

export function widestTaskExposure(
	states: readonly ResourceServer[],
	exposures: ReadonlyMap<string, Exposure>,
): Exposure {
	let best: Exposure = "hidden";
	for (const state of states) {
		if (state.status !== "connected" || state.enabled === false || !hasTasks(state)) continue;
		const e = exposures.get(state.name) ?? "codemode";
		if (exposureRank(e) > exposureRank(best)) best = e;
	}
	return best;
}

export function tasksRuntime(state: ResourceServer & { client?: McpClient }): TasksRuntime {
	if (!state.client) throw new Error(`MCP server "${state.name}" is not connected`);
	return new TasksRuntime({
		serverKey: state.name,
		request: (method, params, opts) => state.client!.request(method, params, opts),
		peerCapabilities: () => (state.capabilities ?? {}) as Record<string, unknown>,
	});
}

/** Present a task handle to the model instead of blocking on completion. */
export async function taskHandleResult(
	state: ResourceServer,
	toolName: string,
	outcome: Extract<Outcome<ToolCallResult>, { kind: "task-handle" }>,
): Promise<ToolResult> {
	const handle = outcome.handle as { id: string; status(): string | undefined };
	const status = handle.status() ?? "working";
	return {
		content: [{
			type: "text",
			text: `Task ${handle.id} (${status}) started by ${state.name}/${toolName}. Inspect with get_mcp_task({ server: "${state.name}", taskId: "${handle.id}" }) or /mcp task ${state.name} ${handle.id}.`,
		}],
		details: { server: state.name, tool: toolName, taskId: handle.id, status },
		structuredContent: { taskId: handle.id, status },
	};
}

export async function getTask(state: ResourceServer, taskId: string): Promise<TaskState> {
	const handle = tasksRuntime(state as never).resume(taskId);
	const outcome = await handle.get();
	if (outcome.kind !== "ok") throw new Error(`tasks/get failed: ${outcome.kind}`);
	return outcome.value as TaskState;
}

export async function cancelTask(state: ResourceServer, taskId: string): Promise<TaskState> {
	const handle = tasksRuntime(state as never).resume(taskId);
	const outcome = await handle.cancel();
	if (outcome.kind !== "ok") throw new Error(`tasks/cancel failed: ${outcome.kind}`);
	return outcome.value as TaskState;
}

export async function updateTask(
	state: ResourceServer,
	taskId: string,
	inputResponses: Record<string, unknown>,
): Promise<TaskState> {
	const handle = tasksRuntime(state as never).resume(taskId);
	const outcome = await handle.update(inputResponses);
	if (outcome.kind !== "ok") throw new Error(`tasks/update failed: ${outcome.kind}`);
	return outcome.value as TaskState;
}

export class TaskTools {
	#lastExposure: Exposure | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly states: () => ResourceServer[],
		private readonly exposures: ReadonlyMap<string, Exposure>,
	) {}

	ensure(): void {
		const next = widestTaskExposure(this.states(), this.exposures);
		if (next === this.#lastExposure || (this.#lastExposure === undefined && next === "hidden")) return;
		const wasDirect = this.#lastExposure === "direct";
		this.#lastExposure = next;
		const exposure = toPiExposure(next);

		this.pi.registerTool({
			name: "get_mcp_task",
			label: "Get MCP Task",
			description: "Poll SEP-2663 task status and result by server and taskId.",
			parameters: {
				type: "object",
				properties: { server: { type: "string" }, taskId: { type: "string" } },
				required: ["server", "taskId"],
			},
			exposure,
			annotations: { readOnlyHint: true },
			execute: async (_id, params) => {
				const state = this.server(String(params.server ?? ""));
				const task = await getTask(state, String(params.taskId ?? ""));
				return {
					content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
					details: { server: state.name, taskId: task.taskId, status: task.status },
					structuredContent: task,
				};
			},
		});
		this.pi.registerTool({
			name: "cancel_mcp_task",
			label: "Cancel MCP Task",
			description: "Request cooperative cancellation of an in-progress SEP-2663 MCP task.",
			parameters: {
				type: "object",
				properties: { server: { type: "string" }, taskId: { type: "string" } },
				required: ["server", "taskId"],
			},
			exposure,
			annotations: { readOnlyHint: false, idempotentHint: true },
			execute: async (_id, params) => {
				const state = this.server(String(params.server ?? ""));
				const task = await cancelTask(state, String(params.taskId ?? ""));
				return {
					content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
					details: { server: state.name, taskId: task.taskId, status: task.status },
					structuredContent: task,
				};
			},
		});
		this.pi.registerTool({
			name: "update_mcp_task",
			label: "Update MCP Task",
			description: "Submit inputResponses for an input_required SEP-2663 MCP task.",
			parameters: {
				type: "object",
				properties: {
					server: { type: "string" },
					taskId: { type: "string" },
					inputResponses: { type: "object" },
				},
				required: ["server", "taskId", "inputResponses"],
			},
			exposure,
			annotations: { readOnlyHint: false },
			execute: async (_id, params) => {
				const state = this.server(String(params.server ?? ""));
				const responses = (typeof params.inputResponses === "object" && params.inputResponses !== null
					? params.inputResponses
					: {}) as Record<string, unknown>;
				const task = await updateTask(state, String(params.taskId ?? ""), responses);
				return {
					content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
					details: { server: state.name, taskId: task.taskId, status: task.status },
					structuredContent: task,
				};
			},
		});

		if (wasDirect && exposure !== "direct") {
			const drop = new Set<string>(TASK_TOOL_NAMES);
			this.pi.setActiveTools(this.pi.getActiveTools().filter((n) => !drop.has(n)));
		}
	}

	private server(name: string): ResourceServer {
		const state = this.states().find((s) => s.name === name);
		if (!state || state.status !== "connected" || state.enabled === false) {
			throw new Error(`MCP server "${name}" is not connected`);
		}
		return state;
	}
}
