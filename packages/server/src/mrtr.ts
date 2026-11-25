import { createHmac, timingSafeEqual } from "node:crypto";
import { ServerError, type Obj } from "@mcp-client/server-events";

/** Multi Round-Trip Request interim result. At least one field is required. */
export function inputRequired(input: {
	readonly inputRequests?: Record<string, { readonly method: string; readonly params: Obj }>;
	readonly requestState?: string;
}): Obj {
	if (input.inputRequests === undefined && input.requestState === undefined) {
		throw new ServerError(-32603, "input_required needs inputRequests or requestState");
	}
	return {
		resultType: "input_required",
		...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}),
		...(input.requestState !== undefined ? { requestState: input.requestState } : {}),
	};
}

/** Opaque, integrity-protected requestState (HMAC-SHA256 over method + payload). */
export function issueRequestState(secret: string, method: string, payload: Obj = {}): string {
	const body = Buffer.from(JSON.stringify({ method, payload }), "utf8");
	const signature = createHmac("sha256", secret).update(body).digest("base64url");
	return `${body.toString("base64url")}.${signature}`;
}

/** Verify and decode requestState; tampered or wrong-method state is rejected. */
export function verifyRequestState(secret: string, state: unknown, method: string): Obj {
	if (typeof state !== "string") throw new ServerError(-32602, "requestState must be a string");
	const [encoded, signature] = state.split(".");
	if (!encoded || !signature) throw new ServerError(-32602, "invalid requestState");
	const body = Buffer.from(encoded, "base64url");
	const expected = createHmac("sha256", secret).update(body).digest("base64url");
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ServerError(-32602, "invalid requestState");
	try {
		const parsed = JSON.parse(body.toString("utf8")) as { method?: unknown; payload?: unknown };
		if (parsed.method !== method || typeof parsed.payload !== "object" || parsed.payload === null) {
			throw new ServerError(-32602, "requestState method mismatch");
		}
		return parsed.payload as Obj;
	} catch (error) {
		if (error instanceof ServerError) throw error;
		throw new ServerError(-32602, "invalid requestState");
	}
}

/** Validate a retry's inputResponses shape; unknown keys are ignored by design. */
export function readInputResponses(params: Obj): Obj | undefined {
	const responses = params.inputResponses;
	if (responses === undefined) return undefined;
	if (typeof responses !== "object" || responses === null || Array.isArray(responses)) {
		throw new ServerError(-32602, "inputResponses must be an object");
	}
	return responses as Obj;
}

interface PendingMrtr {
	readonly method: string;
	readonly inputRequests?: Record<string, { readonly method: string; readonly params: Obj }>;
}

/**
 * Server-side MRTR correlation: issue an interim result, then validate the
 * retry's requestState and inputResponses. States are single-use to prevent
 * replay of one-time inputs.
 */
export class MrtrRegistry {
	readonly #pending = new Map<string, PendingMrtr>();

	constructor(private readonly secret: string) {}

	begin(method: string, input: {
		readonly inputRequests?: Record<string, { readonly method: string; readonly params: Obj }>;
		readonly payload?: Obj;
	}): Obj {
		const requestState = issueRequestState(this.secret, method, input.payload ?? {});
		this.#pending.set(requestState, { method, ...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}) });
		return inputRequired({
			...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}),
			requestState,
		});
	}

	/** Validate a retry and consume its state. Missing inputs are re-requested. */
	resume(method: string, params: Obj): { readonly inputResponses?: Obj; readonly payload: Obj; readonly retry?: Obj } {
		const state = params.requestState;
		if (state === undefined) {
			if (params.inputResponses !== undefined) throw new ServerError(-32602, "inputResponses without requestState");
			return { payload: {} };
		}
		const pending = this.#pending.get(state as string);
		if (!pending || pending.method !== method) throw new ServerError(-32602, "unknown or mismatched requestState");
		const payload = verifyRequestState(this.secret, state, method);
		if (pending.inputRequests) {
			const responses = readInputResponses(params);
			const missing = Object.keys(pending.inputRequests).filter((key) => responses?.[key] === undefined);
			if (!responses || missing.length > 0) {
				return { payload, retry: inputRequired({ inputRequests: pending.inputRequests, requestState: state as string }) };
			}
			this.#pending.delete(state as string);
			return { inputResponses: responses, payload };
		}
		this.#pending.delete(state as string);
		return { payload };
	}
}
