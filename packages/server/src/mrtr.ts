import { createHmac, timingSafeEqual } from "node:crypto";
import { systemClock, type Clock } from "@mcp/core";
import { object, ServerError, type Obj } from "@mcp/server-events";

const DEPRECATED_INPUT_METHODS = new Set(["sampling/createMessage", "roots/list"]);

export interface InputRequestSpec {
	readonly method: string;
	readonly params: Obj;
}

/** Multi Round-Trip Request interim result (SEP-2322). Deprecated sampling/roots are rejected (SEP-2577). */
export function inputRequired(input: {
	readonly inputRequests?: Record<string, InputRequestSpec>;
	readonly requestState?: string;
	readonly clientCapabilities?: Obj;
}): Obj {
	if (input.inputRequests === undefined && input.requestState === undefined) {
		throw new ServerError(-32603, "input_required needs inputRequests or requestState");
	}
	if (input.inputRequests !== undefined) {
		for (const [key, req] of Object.entries(input.inputRequests)) {
			if (!key) throw new ServerError(-32603, "inputRequests key must be non-empty");
			if (DEPRECATED_INPUT_METHODS.has(req.method)) {
				throw new ServerError(-32602, `deprecated MRTR input request method not permitted in 2026-07-28: ${req.method}`);
			}
			if (req.method !== "elicitation/create") {
				throw new ServerError(-32602, `unsupported MRTR input request method: ${req.method}`);
			}
			if (input.clientCapabilities !== undefined && !object(input.clientCapabilities.elicitation)) {
				throw new ServerError(-32021, "client did not declare elicitation capability", {
					requiredCapabilities: { elicitation: {} },
				});
			}
		}
	}
	return {
		resultType: "input_required",
		...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}),
		...(input.requestState !== undefined ? { requestState: input.requestState } : {}),
	};
}

export interface RequestStateClaims {
	readonly principal?: string;
	readonly expMs?: number;
	readonly argsDigest?: string;
}

export interface VerifyRequestStateOptions {
	readonly principal?: string;
	readonly nowMs?: number;
	readonly argsDigest?: string;
}

/** Opaque, integrity-protected requestState (HMAC-SHA256 over method + claims + payload). */
export function issueRequestState(secret: string, method: string, payload: Obj = {}, claims?: RequestStateClaims): string {
	const envelope: Obj = {
		method,
		payload,
		...(claims?.principal !== undefined ? { principal: claims.principal } : {}),
		...(claims?.expMs !== undefined ? { expMs: claims.expMs } : {}),
		...(claims?.argsDigest !== undefined ? { argsDigest: claims.argsDigest } : {}),
	};
	const body = Buffer.from(JSON.stringify(envelope), "utf8");
	const signature = createHmac("sha256", secret).update(body).digest("base64url");
	return `${body.toString("base64url")}.${signature}`;
}

/** Verify and decode requestState; tampered, expired, or wrong-principal/method state is rejected. */
export function verifyRequestState(
	secret: string,
	state: unknown,
	method: string,
	opts?: VerifyRequestStateOptions,
): Obj {
	if (typeof state !== "string") throw new ServerError(-32602, "requestState must be a string");
	const parts = state.split(".");
	if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ServerError(-32602, "invalid requestState");
	const [encoded, signature] = parts;
	const body = Buffer.from(encoded, "base64url");
	const expected = createHmac("sha256", secret).update(body).digest("base64url");
	const a = Buffer.from(signature);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ServerError(-32602, "invalid requestState");
	let parsed: { method?: unknown; payload?: unknown; principal?: unknown; expMs?: unknown; argsDigest?: unknown };
	try {
		parsed = JSON.parse(body.toString("utf8")) as typeof parsed;
	} catch {
		throw new ServerError(-32602, "invalid requestState");
	}
	if (parsed.method !== method || !object(parsed.payload)) {
		throw new ServerError(-32602, "requestState method mismatch");
	}
	if (parsed.principal !== undefined && parsed.principal !== opts?.principal) {
		throw new ServerError(-32602, "requestState principal mismatch");
	}
	if (opts?.principal !== undefined && parsed.principal !== opts.principal) {
		throw new ServerError(-32602, "requestState principal mismatch");
	}
	if (typeof parsed.expMs === "number" && (opts?.nowMs ?? Date.now()) > parsed.expMs) {
		throw new ServerError(-32602, "requestState expired");
	}
	if (parsed.argsDigest !== undefined && opts?.argsDigest !== undefined && parsed.argsDigest !== opts.argsDigest) {
		throw new ServerError(-32602, "requestState argument digest mismatch");
	}
	return parsed.payload;
}

/** Validate a retry's inputResponses shape; unknown keys are ignored by design. */
export function readInputResponses(params: Obj): Obj | undefined {
	const responses = params.inputResponses;
	if (responses === undefined) return undefined;
	if (!object(responses)) {
		throw new ServerError(-32602, "inputResponses must be an object");
	}
	return responses;
}

interface PendingMrtr {
	readonly method: string;
	readonly inputRequests?: Record<string, InputRequestSpec>;
	readonly principal?: string;
	readonly expMs?: number;
}

export interface MrtrRegistryOptions {
	readonly clock?: Clock;
	readonly defaultTtlMs?: number;
}

/**
 * Server-side MRTR correlation: issue an interim result, then validate the
 * retry's requestState and inputResponses. States are single-use to prevent
 * replay of one-time inputs.
 */
export class MrtrRegistry {
	readonly #pending = new Map<string, PendingMrtr>();
	readonly #clock: Clock;
	readonly #defaultTtlMs: number | undefined;

	constructor(
		private readonly secret: string,
		opts: MrtrRegistryOptions = {},
	) {
		this.#clock = opts.clock ?? systemClock;
		this.#defaultTtlMs = opts.defaultTtlMs;
	}

	begin(method: string, input: {
		readonly inputRequests?: Record<string, InputRequestSpec>;
		readonly payload?: Obj;
		readonly principal?: string;
		readonly ttlMs?: number;
		readonly argsDigest?: string;
		readonly clientCapabilities?: Obj;
	}): Obj {
		const ttl = input.ttlMs ?? this.#defaultTtlMs;
		const expMs = ttl !== undefined ? this.#clock.now() + ttl : undefined;
		const requestState = issueRequestState(this.secret, method, input.payload ?? {}, {
			...(input.principal !== undefined ? { principal: input.principal } : {}),
			...(expMs !== undefined ? { expMs } : {}),
			...(input.argsDigest !== undefined ? { argsDigest: input.argsDigest } : {}),
		});
		const built = inputRequired({
			...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}),
			requestState,
			...(input.clientCapabilities !== undefined ? { clientCapabilities: input.clientCapabilities } : {}),
		});
		this.#pending.set(requestState, {
			method,
			...(input.inputRequests !== undefined ? { inputRequests: input.inputRequests } : {}),
			...(input.principal !== undefined ? { principal: input.principal } : {}),
			...(expMs !== undefined ? { expMs } : {}),
		});
		return built;
	}

	/** Validate a retry and consume its state. Missing inputs are re-requested. */
	resume(method: string, params: Obj, opts?: { readonly principal?: string; readonly argsDigest?: string }): {
		readonly inputResponses?: Obj;
		readonly payload: Obj;
		readonly retry?: Obj;
	} {
		const state = params.requestState;
		if (state === undefined) {
			if (params.inputResponses !== undefined) throw new ServerError(-32602, "inputResponses without requestState");
			return { payload: {} };
		}
		if (typeof state !== "string") throw new ServerError(-32602, "requestState must be a string");
		const pending = this.#pending.get(state);
		if (!pending || pending.method !== method) throw new ServerError(-32602, "unknown or mismatched requestState");
		const payload = verifyRequestState(this.secret, state, method, {
			nowMs: this.#clock.now(),
			...(opts?.principal !== undefined
				? { principal: opts.principal }
				: pending.principal !== undefined
					? { principal: pending.principal }
					: {}),
			...(opts?.argsDigest !== undefined ? { argsDigest: opts.argsDigest } : {}),
		});
		if (pending.inputRequests) {
			const responses = readInputResponses(params);
			const missing = Object.keys(pending.inputRequests).filter((key) => responses?.[key] === undefined);
			if (!responses || missing.length > 0) {
				return { payload, retry: inputRequired({ inputRequests: pending.inputRequests, requestState: state }) };
			}
			this.#pending.delete(state);
			return { inputResponses: responses, payload };
		}
		this.#pending.delete(state);
		return { payload };
	}
}
