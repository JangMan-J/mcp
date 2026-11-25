import { ServerError, type Obj } from "@mcp-client/server-events";

export const PROTOCOL_VERSION = "2026-07-28";

export interface CacheHints {
	/** Freshness hint in milliseconds; 0 means immediately stale. */
	readonly ttlMs: number;
	readonly cacheScope: "public" | "private";
}

export const DEFAULT_CACHE_HINTS: CacheHints = { ttlMs: 0, cacheScope: "private" };

/** Ordinary complete result, with optional CacheableResult fields. */
export function complete(result: Obj, cache?: CacheHints): Obj {
	return {
		resultType: "complete",
		...result,
		...(cache !== undefined ? { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope } : {}),
	};
}

export interface Page<T> {
	readonly items: readonly T[];
	readonly nextCursor?: string;
}

/**
 * Offset-based opaque server cursors. Input order must be deterministic;
 * clients never see or parse the offset. Invalid cursors are -32602.
 */
export function paginate<T>(items: readonly T[], cursor: unknown, pageSize = 100): Page<T> {
	let offset = 0;
	if (cursor !== undefined && cursor !== null) {
		if (typeof cursor !== "string" || !/^\d+$/u.test(cursor)) throw new ServerError(-32602, "invalid cursor");
		offset = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
			throw new ServerError(-32602, "invalid cursor");
		}
	}
	const page = items.slice(offset, offset + pageSize);
	return {
		items: page,
		...(offset + pageSize < items.length ? { nextCursor: String(offset + pageSize) } : {}),
	};
}

/** Validate the stateless per-request metadata required on every request. */
export function validateRequestMeta(params: Obj | undefined, supportedVersions: readonly string[] = [PROTOCOL_VERSION]): void {
	const meta = params?.["_meta"];
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
		throw new ServerError(-32602, "missing required _meta");
	}
	const version = (meta as Obj)["io.modelcontextprotocol/protocolVersion"];
	if (typeof version !== "string" || !supportedVersions.includes(version)) {
		throw new ServerError(-32022, "unsupported protocol version", {
			requested: typeof version === "string" ? version : undefined,
			supported: supportedVersions,
		});
	}
	const capabilities = (meta as Obj)["io.modelcontextprotocol/clientCapabilities"];
	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
		throw new ServerError(-32602, "missing io.modelcontextprotocol/clientCapabilities");
	}
}
