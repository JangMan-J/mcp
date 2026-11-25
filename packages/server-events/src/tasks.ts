import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@mcp/core";
import type { EventBus } from "./bus.js";
import { notification, object, ServerError, type Obj, type PushChannel } from "./types.js";
import { requireTaskId } from "./subscriptions.js";

export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskState extends Obj {
	taskId: string;
	status: TaskStatus;
	createdAt?: string;
	lastUpdatedAt?: string;
	ttlMs?: number | null;
	pollIntervalMs?: number;
	inputRequests?: Record<string, { method: string; params: Obj }>;
}

const TERMINAL = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

/**
 * Optional async-task companion to the push center: task handles whose state
 * changes are emitted as notifications/tasks and published on the "tasks"
 * event stream. No tools framework — hosts decide which operations start tasks.
 */
export class TaskCenter {
	readonly #tasks = new Map<string, TaskState>();
	readonly #clock: Clock;
	readonly #bus: EventBus | undefined;
	readonly #channels = new Map<PushChannel, ReadonlySet<string> | undefined>();

	constructor(opts: { readonly bus?: EventBus; readonly clock?: Clock } = {}) {
		this.#bus = opts.bus;
		this.#clock = opts.clock ?? systemClock;
	}

	capabilities(): Obj {
		return { extensions: { [TASKS_EXTENSION_ID]: {} } };
	}

	/** Attach a push channel (e.g. a subscriptions/listen channel) for notifications/tasks. */
	attach(channel: PushChannel, taskIds?: readonly string[]): void {
		this.#channels.set(channel, taskIds ? new Set(taskIds) : undefined);
		channel.onClose(() => this.#channels.delete(channel));
	}

	create(init: { taskId?: string; ttlMs?: number | null; pollIntervalMs?: number; inputRequests?: TaskState["inputRequests"] } = {}): TaskState {
		const nowIso = new Date(this.#clock.now()).toISOString();
		const state: TaskState = {
			taskId: init.taskId ?? randomUUID(),
			status: init.inputRequests ? "input_required" : "working",
			createdAt: nowIso,
			lastUpdatedAt: nowIso,
			ttlMs: init.ttlMs ?? null,
			...(init.pollIntervalMs !== undefined ? { pollIntervalMs: init.pollIntervalMs } : {}),
			...(init.inputRequests !== undefined ? { inputRequests: init.inputRequests } : {}),
		};
		this.#tasks.set(state.taskId, state);
		this.#emit(state);
		return state;
	}

	get(params: Obj): TaskState {
		return this.#expireIfNeeded(this.#state(requireTaskId(params)));
	}

	cancel(params: Obj): TaskState {
		const state = this.#expireIfNeeded(this.#state(requireTaskId(params)));
		if (TERMINAL.has(state.status)) return state;
		return this.#set(state.taskId, { status: "cancelled" });
	}

	/** Client input for an input_required task; resumes work. */
	update(params: Obj): TaskState {
		const state = this.#state(requireTaskId(params));
		if (state.status !== "input_required") throw new ServerError(-32602, "task is not awaiting input");
		const inputResponses = params.inputResponses;
		if (!object(inputResponses)) throw new ServerError(-32602, "inputResponses must be an object");
		const next: TaskState = { ...state, status: "working", inputResponses };
		delete next.inputRequests;
		return this.#set(state.taskId, next);
	}

	requestInput(taskId: string, inputRequests: NonNullable<TaskState["inputRequests"]>): TaskState {
		this.#state(taskId);
		return this.#set(taskId, { status: "input_required", inputRequests });
	}

	complete(taskId: string, result: Obj): TaskState {
		this.#state(taskId);
		return this.#set(taskId, { status: "completed", result });
	}

	fail(taskId: string, error: Obj): TaskState {
		this.#state(taskId);
		return this.#set(taskId, { status: "failed", error });
	}

	#state(taskId: string): TaskState {
		const state = this.#tasks.get(taskId);
		if (!state) throw new ServerError(-32602, `unknown task: ${taskId}`);
		return state;
	}

	#expireIfNeeded(state: TaskState): TaskState {
		if (TERMINAL.has(state.status) || state.ttlMs === undefined || state.ttlMs === null) return state;
		const createdAt = typeof state.createdAt === "string" ? Date.parse(state.createdAt) : Number.NaN;
		if (Number.isFinite(createdAt) && createdAt + state.ttlMs <= this.#clock.now()) {
			return this.#set(state.taskId, { status: "failed", error: { code: "task-expired" } });
		}
		return state;
	}

	#set(taskId: string, patch: Partial<TaskState>): TaskState {
		const state = {
			...this.#state(taskId),
			...patch,
			taskId,
			lastUpdatedAt: new Date(this.#clock.now()).toISOString(),
		};
		this.#tasks.set(taskId, state);
		this.#emit(state);
		return state;
	}

	#emit(state: TaskState): void {
		for (const [channel, filter] of this.#channels.entries()) {
			if (filter === undefined || filter.has(state.taskId)) {
				channel.notify(notification("notifications/tasks", { ...state }, channel.id));
			}
		}
		this.#bus?.publish("tasks", state, {});
	}
}
