/**
 * OAuth wiring for the Pi bridge: a file-backed CredentialStore (so sign-ins
 * survive restarts, keyed by issuer per SEP-2352) and a per-server
 * OAuthAuthorization factory wired to the host's consent UI and browser.
 *
 * The library (packages/auth) owns the protocol: discovery, CIMD/DCR, PKCE,
 * iss validation, step-up. This module only connects ports to Pi.
 */

import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	canonicalResource,
	OAuthAuthorization,
	openSystemBrowser,
	SafeFetch,
	startHostedRedirect,
	startLoopbackRedirect,
	type AuthorizationConsent,
	type ClientRegistration,
} from "@jangmanj/mcp/auth";
import type { ResolvedServerConfig } from "./config.ts";

export {
	canonicalResource,
	OAuthAuthorization,
	openSystemBrowser,
	startHostedRedirect,
	startLoopbackRedirect,
};
export type { AuthorizationConsent, ClientRegistration };

/** JSON-file CredentialStore: write-through, atomic rename, single-process. */
export class FileCredentialStore {
	readonly #path: string;
	#values: Map<string, string> | undefined;
	#writing: Promise<void> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	async #load(): Promise<Map<string, string>> {
		if (this.#values) return this.#values;
		try {
			const parsed = JSON.parse(await readFile(this.#path, "utf8"));
			this.#values = new Map(Object.entries(parsed));
		} catch {
			this.#values = new Map();
		}
		return this.#values;
	}

	async #flush(): Promise<void> {
		const snapshot = JSON.stringify(Object.fromEntries(this.#values ?? new Map()));
		this.#writing = this.#writing.then(async () => {
			await mkdir(dirname(this.#path), { recursive: true });
			const tmp = `${this.#path}.${process.pid}.tmp`;
			await writeFile(tmp, snapshot, { mode: 0o600 });
			await rename(tmp, this.#path);
		});
		return this.#writing;
	}

	async get(key: string): Promise<string | undefined> {
		return (await this.#load()).get(key);
	}

	async set(key: string, value: string): Promise<void> {
		(await this.#load()).set(key, value);
		await this.#flush();
	}

	async delete(key: string): Promise<void> {
		if ((await this.#load()).delete(key)) await this.#flush();
	}

	/** Delete every entry whose key mentions the resource (logout). */
	async deleteResource(resource: string): Promise<number> {
		const values = await this.#load();
		let n = 0;
		for (const key of [...values.keys()]) {
			if (key.includes(resource)) {
				values.delete(key);
				n++;
			}
		}
		if (n > 0) await this.#flush();
		return n;
	}
}

export interface OAuthProviderOptions {
	readonly config: ResolvedServerConfig;
	readonly store: FileCredentialStore;
	/** Gate: consent prompts proceed only when this returns true (e.g. /mcp login armed). */
	readonly interactive: () => boolean;
	/** Host confirm dialog; when absent all prompts decline. */
	readonly confirm?: (title: string, message: string) => Promise<boolean>;
	readonly browserOpen?: (url: string, signal: AbortSignal) => Promise<void>;
	readonly allowInsecureAuth?: boolean;
}

export interface OAuthProviderHandle {
	readonly provider: OAuthAuthorization;
	readonly closeRedirect: () => void;
}

/** True for a loopback HTTP redirect URI, which binds a fixed local port directly. */
function isLoopbackHttp(redirectUri: string): boolean {
	let url: URL;
	try { url = new URL(redirectUri); } catch { return false; }
	return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

async function startFixedRedirect(redirectUri: string): Promise<{ close: () => void; waitForCallback: (opts: { redirectUri: string; state: string; signal: AbortSignal }) => Promise<URLSearchParams> }> {	const url = new URL(redirectUri);
	if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		throw new Error(`oauth callback must be loopback HTTP: ${redirectUri}`);
	}
	const path = url.pathname || "/callback";
	let pending: { resolve: (v: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
	const server: Server = createServer((request, response) => {
		const target = request.url ?? "";
		if (request.method !== "GET" || !target.startsWith(`${path}?`) || !pending) {
			response.writeHead(404, { Connection: "close" }).end();
			return;
		}
		const resolve = pending.resolve;
		pending = undefined;
		response
			.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close" })
			.end("Authorization response received. You can close this tab.");
		resolve(new URLSearchParams(target.slice(path.length + 1)));
		server.close();
	});
	server.requestTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(url.port || 80), "127.0.0.1", resolve);
	});
	return {
		close: () => {
			pending?.reject(new Error("cancelled"));
			pending = undefined;
			server.close();
			server.closeAllConnections();
		},
		waitForCallback: async (opts) => {
			if (opts.redirectUri !== redirectUri) throw new Error("invalid-redirect-uri");
			const work = new Promise<URLSearchParams>((resolve, reject) => {
				pending = { resolve, reject };
			});
			opts.signal.addEventListener("abort", () => pending?.reject(new Error("cancelled")), { once: true });
			return work;
		},
	};
}

export async function createOAuthProvider(opts: OAuthProviderOptions): Promise<OAuthProviderHandle> {
	const { config } = opts;
	// callbackUrl wins; callbackPort fixes the port of /callback; otherwise an
	// ephemeral loopback listener from the library. A public https callbackUrl is
	// served by the library's hosted redirect listener (bind loopback, publish the
	// configured URI) instead of a loopback-only one.
	const redirectUri =
		config.oauth?.callbackUrl ??
		(config.oauth?.callbackPort !== undefined
			? `http://127.0.0.1:${config.oauth.callbackPort}/callback`
			: undefined);
	const redirect = redirectUri === undefined
		? await startLoopbackRedirect("/callback")
		: isLoopbackHttp(redirectUri)
			? await startFixedRedirect(redirectUri)
			: await startHostedRedirect({
				redirectUri,
				// A public URL may name the local bind port; otherwise the listener takes an ephemeral one.
				...(() => {
					const port = new URL(redirectUri).port;
					return port === "" ? {} : { port: Number(port) };
				})(),
				// The listener binds loopback, so only a local proxy can reach it: trust its forwarded host.
				trustProxy: true,
			});
	const effectiveRedirectUri = redirectUri ?? ("redirectUri" in redirect ? redirect.redirectUri : undefined);
	if (typeof effectiveRedirectUri !== "string") throw new Error("oauth redirect URI unavailable");

	const consent: AuthorizationConsent = {
		request: async (prompt, signal) => {
			if (!opts.interactive() || signal.aborted) return { decision: "decline" };
			if (prompt.kind === "client-info") {
				// No CIMD/DCR available: supply a statically configured client, if any.
				const oauth = config.oauth;
				if (oauth?.clientId) {
					const registration: ClientRegistration = {
						clientId: oauth.clientId,
						redirectUris: [effectiveRedirectUri],
						...(oauth.clientSecret !== undefined ? { clientSecret: oauth.clientSecret } : {}),
					};
					return { decision: "accept", registration };
				}
				return { decision: "decline" };
			}
			const ok = await (opts.confirm?.(
				`Authorize MCP server "${prompt.serverLabel}"?`,
				`${prompt.issuerHost} will open in your browser to grant access to ${prompt.resource}.` +
					(prompt.scopes.length > 0 ? ` Scopes: ${prompt.scopes.join(" ")}.` : "") +
					(prompt.localhostWarning ? "\nWarning: the authorization server is on localhost." : ""),
			) ?? Promise.resolve(false));
			if (signal.aborted) return { decision: "cancel" };
			return ok ? { decision: "accept" } : { decision: "decline" };
		},
	};

	const provider = new OAuthAuthorization({
		resource: config.url as string,
		redirectUri: effectiveRedirectUri,
		redirect,
		browser: { open: opts.browserOpen ?? openSystemBrowser },
		credentials: opts.store,
		consent,
		serverLabel: config.name,
		dynamicRegistration: { clientName: config.oauth?.clientName ?? "pi" },
		...(config.oauth?.scope !== undefined ? { scope: config.oauth.scope } : {}),
		...(config.oauth?.authServerMetadataUrl !== undefined
			? { authServerMetadataUrl: config.oauth.authServerMetadataUrl }
			: {}),
		fetch: new SafeFetch({
			allowInsecureDev: opts.allowInsecureAuth ?? false,
			// Insecure-dev mode also permits loopback targets (local dev servers,
			// tests); production keeps SafeFetch's SSRF address blocks.
			...(opts.allowInsecureAuth
				? { allowAddress: (hostname: string) => ["127.0.0.1", "localhost", "::1"].includes(hostname) }
				: {}),
		}),
		...(opts.allowInsecureAuth !== undefined ? { allowInsecureDev: opts.allowInsecureAuth } : {}),
	});
	return { provider, closeRedirect: redirect.close };
}
