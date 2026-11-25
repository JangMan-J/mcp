import { object, ServerError, type Obj } from "@mcp/server-events";

export const PROTOCOL_VERSION = "2026-07-28";

export interface ServerInfo {
	readonly name: string;
	readonly version: string;
	readonly title?: string;
}

export interface CacheHints {
	/** Freshness hint in milliseconds; 0 means immediately stale. */
	readonly ttlMs: number;
	readonly cacheScope: "public" | "private";
}

export const DEFAULT_CACHE_HINTS: CacheHints = { ttlMs: 0, cacheScope: "private" };

/** Ordinary complete result, with optional CacheableResult fields and 2026-07-28 _meta serverInfo. */
export function complete(result: Obj, cache?: CacheHints, serverInfo?: ServerInfo): Obj {
	const existingMeta = object(result._meta) ? result._meta : undefined;
	const meta = serverInfo
		? { ...existingMeta, "io.modelcontextprotocol/serverInfo": serverInfo }
		: existingMeta;
	return {
		resultType: "complete",
		...result,
		...(cache !== undefined ? { ttlMs: cache.ttlMs, cacheScope: cache.cacheScope } : {}),
		...(meta !== undefined ? { _meta: meta } : {}),
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

/** Validate the stateless per-request metadata required on every 2026-07-28 request. */
export function validateRequestMeta(params: Obj | undefined, supportedVersions: readonly string[] = [PROTOCOL_VERSION]): Obj {
	if (params !== undefined && !object(params)) {
		throw new ServerError(-32602, "params must be an object");
	}
	const meta = params?.["_meta"];
	if (!object(meta)) {
		throw new ServerError(-32602, "missing required _meta");
	}
	const version = meta["io.modelcontextprotocol/protocolVersion"];
	if (typeof version !== "string") {
		throw new ServerError(-32602, "missing io.modelcontextprotocol/protocolVersion");
	}
	if (!supportedVersions.includes(version)) {
		throw new ServerError(-32022, `Unsupported protocol version (supported: ${supportedVersions.join(", ")})`, {
			requested: version,
			supported: [...supportedVersions],
		});
	}
	const capabilities = meta["io.modelcontextprotocol/clientCapabilities"];
	if (!object(capabilities)) {
		throw new ServerError(-32602, "missing io.modelcontextprotocol/clientCapabilities");
	}
	const clientInfo = meta["io.modelcontextprotocol/clientInfo"];
	if (clientInfo !== undefined && !object(clientInfo)) {
		throw new ServerError(-32602, "io.modelcontextprotocol/clientInfo must be an object");
	}
	return meta;
}
