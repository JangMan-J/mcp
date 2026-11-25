/** Task-based tool-call results and /mcp task helpers. */

import type { Outcome } from "@jangmanj/mcp/core";
import type { McpClient } from "@jangmanj/mcp/core";
import { TasksRuntime, type TaskState } from "@jangmanj/mcp/mrtr-cache";
import type { ToolCallResult } from "@jangmanj/mcp/ops";
import type { ResourceServer } from "./resources.ts";
import type { ToolResult } from "./pi-api.ts";

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
			text: `Task ${handle.id} (${status}) started by ${state.name}/${toolName}. Poll with /mcp task ${state.name} ${handle.id}.`,
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
