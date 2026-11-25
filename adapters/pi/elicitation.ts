/** MRTR + elicitation support using the host's Pi UI. */

import { openSystemBrowser } from "../../dist/auth/index.js";
import type { Outcome } from "../../dist/index.js";
import type { ConsentPort } from "../../dist/index.js";
import { elicit, type FormRequest } from "../../dist/mrtr-cache/index.js";
import { normalizeContent, type ToolCallResult } from "../../dist/ops/index.js";
import type { ResourceServer } from "./resources.ts";
import type { Ui } from "./pi-api.ts";

function formPort(ui: Ui) {
	return async (request: FormRequest, signal: AbortSignal) => {
		if (!ui.input && !ui.confirm) return { action: "decline" as const };
		const content: Record<string, unknown> = {};
		const properties = (request.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
		for (const [key, schema] of Object.entries(properties)) {
			const def = request.defaults[key];
			const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((v): v is string => typeof v === "string") : undefined;
			let value: unknown = def;
			if (enumValues && ui.select) {
				const selected = await ui.select(`${key}:`, enumValues.map((v) => String(v)));
				if (selected !== undefined) value = selected;
			} else if (ui.input) {
				const answer = await ui.input(`${key}:`, def === undefined ? "" : String(def));
				if (answer !== undefined) value = answer;
			}
			if (value === undefined) return { action: "cancel" as const };
			content[key] = value;
		}
		if (ui.confirm) {
			const ok = await ui.confirm(
				`MCP server "${request.serverLabel}" requests information`,
				`${request.message}\n${request.suspectSensitiveFields.length > 0 ? "\nIncludes potentially sensitive fields." : ""}`,
			);
			if (!ok) return { action: "decline" as const };
		}
		if (signal.aborted) return { action: "cancel" as const };
		return { action: "accept" as const, content };
	};
}

/** ConsentPort used to declare form/url elicitation capabilities to servers. */
export function consentPort(ui: Ui, serverLabel: string): ConsentPort {
	return {
		request: async (prompt, signal) => {
			if (prompt.kind === "form-elicitation") {
				const result = await formPort(ui)({
					serverLabel,
					message: prompt.message ?? "Input requested",
					schema: prompt.schema ?? { type: "object", properties: {} },
					defaults: {},
					suspectSensitiveFields: [],
					invalidPrevious: false,
				}, signal);
				return result.action === "accept"
					? { decision: "accept", content: result.content }
					: { decision: result.action };
			}
			const ok = await (ui.confirm?.(
				prompt.kind === "url-elicitation" ? "Open URL?" : "MCP consent",
				prompt.message ?? prompt.url ?? prompt.serverLabel,
			) ?? Promise.resolve(false));
			return ok ? { decision: "accept" } : { decision: "decline" };
		},
	};
}

/** Call a tool, fulfilling elicitation/create input requests across MRTR rounds. */
export async function callWithElicitation(
	state: ResourceServer,
	toolName: string,
	params: Record<string, unknown>,
	opts: { signal?: AbortSignal; onProgress?: (p: unknown) => void },
	ui: Ui,
): Promise<Outcome<ToolCallResult>> {
	if (!state.ops) throw new Error(`MCP server "${state.name}" is not connected`);
	let current = params;
	let extra: Record<string, unknown> = {};
	for (let round = 0; round < 8; round++) {
		const raw = await state.client!.request("tools/call", {
			name: toolName,
			arguments: current,
			...extra,
		}, {
			mrtr: "manual",
			...(opts.signal !== undefined ? { signal: opts.signal } : {}),
			...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
		});
		if (raw.kind === "ok") {
			const value = raw.value as Record<string, unknown>;
			return {
				kind: "ok",
				value: {
					raw: value,
					content: normalizeContent(value.content),
					...(value.structuredContent !== undefined ? { structuredContent: value.structuredContent } : {}),
					validation: { status: "skipped" },
				},
				meta: raw.meta,
			};
		}
		if (raw.kind !== "mrtr-interim") return raw as Outcome<ToolCallResult>;
		const responses: Record<string, unknown> = {};
		for (const [key, request] of Object.entries(raw.inputRequests ?? {})) {
			const req = request as { method?: string; params?: Record<string, unknown> };
			if (req.method !== "elicitation/create" || !req.params) {
				throw new Error(`unsupported MRTR input request: ${req.method ?? "unknown"}`);
			}
			const result = await elicit(req.params, {
				serverLabel: state.name,
				port: {
					form: formPort(ui),
					url: async (request) => {
						if (!ui.confirm) return "decline";
						const ok = await ui.confirm(
							`MCP server "${state.name}" requests authorization`,
							`${request.message}\nOpen ${request.hostHighlight} in your browser?`,
						);
						return ok ? "accept" : "decline";
					},
				},
				browser: { open: openSystemBrowser },
			}, opts.signal ?? new AbortController().signal);
			if (result.action !== "accept") throw new Error(`elicitation ${result.action}`);
			responses[key] = { action: result.action, ...(result.content !== undefined ? { content: result.content } : {}) };
		}
		extra = {
			inputResponses: responses,
			...(raw.requestState !== undefined ? { requestState: raw.requestState } : {}),
		};
	}
	throw new Error("too many MRTR rounds");
}
