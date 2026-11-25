import { timingSafeEqual } from "node:crypto";

export interface ResourceAuthContext {
	readonly contextId: string;
	readonly scopes?: readonly string[];
}

/** Resource-side bearer check; return undefined to reject with 401. */
export interface BearerAuthenticator {
	authenticate(authorization: string | undefined): Promise<ResourceAuthContext | undefined> | ResourceAuthContext | undefined;
}

export class StaticBearerAuth implements BearerAuthenticator {
	readonly #token: string;
	readonly #contextId: string;

	constructor(token: string, contextId = "static") {
		this.#token = token;
		this.#contextId = contextId;
	}

	authenticate(authorization: string | undefined): ResourceAuthContext | undefined {
		if (authorization !== `Bearer ${this.#token}`) return undefined;
		const a = Buffer.from(authorization);
		const b = Buffer.from(`Bearer ${this.#token}`);
		if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
		return { contextId: this.#contextId };
	}
}

/** RFC 9728 Protected Resource Metadata document for hosts to serve. */
export function buildProtectedResourceMetadata(input: {
	readonly resource: string;
	readonly authorizationServers: readonly string[];
	readonly scopesSupported?: readonly string[];
}): Record<string, unknown> {
	return {
		resource: input.resource,
		authorization_servers: [...input.authorizationServers],
		...(input.scopesSupported !== undefined ? { scopes_supported: [...input.scopesSupported] } : {}),
	};
}

export function bearerChallenge(resourceMetadataUrl: string, scope?: string): string {
	return `Bearer resource_metadata="${resourceMetadataUrl}"${scope !== undefined ? `, scope="${scope}"` : ""}`;
}
