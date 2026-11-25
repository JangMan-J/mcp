/**
 * Synthetic OAuth-protected MCP HTTP server for bridge tests.
 * Loopback only; never use with real credentials. Combines:
 *   - an MCP streamable-HTTP endpoint at /mcp (JSON responses)
 *   - a minimal authorization server (PRM, AS metadata, authorize, token)
 * Patterned after packages/auth/test/fixtures/test-as.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const ACCESS_TOKEN = "test-access";
const REFRESH_TOKEN = "test-refresh";
const CLIENT_ID = "test-client";

export async function startOAuthMcpServer() {
	const codes = new Map(); // code -> { challenge, expires }
	let issuer = "";
	const calls = [];

	const rpc = (msg) => {
		const result = (value) => ({ jsonrpc: "2.0", id: msg.id, result: value });
		switch (msg.method) {
			case "server/discover":
				return result({
					cacheScope: "public",
					capabilities: { tools: {} },
					instructions: "OAuth test server.",
					serverInfo: { name: "oauth-fake", version: "0.0.1" },
				});
			case "tools/list":
				return result({
					tools: [
						{
							name: "echo",
							description: "Echo",
							inputSchema: {
								type: "object",
								properties: { message: { type: "string" } },
							},
						},
					],
				});
			case "tools/call":
				return result({
					content: [{ type: "text", text: String(msg.params?.arguments?.message ?? "") }],
				});
			default:
				return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
		}
	};

	const server = createServer(async (request, response) => {
		let url;
		try {
			url = new URL(request.url ?? "/", issuer);
		} catch {
			return response.writeHead(400).end();
		}
		calls.push(`${request.method} ${url.pathname}`);
		const json = (status, value) =>
			response
				.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" })
				.end(JSON.stringify(value));
		const resource = `${issuer}/mcp`;

		if (request.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource/mcp") {
			return json(200, { resource, authorization_servers: [issuer], scopes_supported: ["read"] });
		}
		if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
			return json(200, {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				code_challenge_methods_supported: ["S256"],
				authorization_response_iss_parameter_supported: true,
			});
		}
		if (request.method === "GET" && url.pathname === "/authorize") {
			const p = url.searchParams;
			const challenge = p.get("code_challenge");
			if (
				!challenge ||
				p.get("client_id") !== CLIENT_ID ||
				p.get("response_type") !== "code" ||
				!p.get("state") ||
				!p.get("redirect_uri")
			) {
				return json(400, { error: "invalid_request" });
			}
			const callback = new URL(p.get("redirect_uri"));
			const code = randomBytes(24).toString("base64url");
			codes.set(code, { challenge, expires: Date.now() + 60_000 });
			callback.searchParams.set("code", code);
			callback.searchParams.set("state", p.get("state"));
			callback.searchParams.set("iss", issuer);
			return response.writeHead(302, { Location: callback.href, "Cache-Control": "no-store" }).end();
		}
		if (request.method === "POST" && url.pathname === "/token") {
			let text = "";
			for await (const chunk of request) {
				text += chunk;
				if (text.length > 8192) return json(413, { error: "invalid_request" });
			}
			const p = new URLSearchParams(text);
			if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === REFRESH_TOKEN) {
				return json(200, {
					token_type: "Bearer",
					access_token: ACCESS_TOKEN,
					refresh_token: REFRESH_TOKEN,
					expires_in: 3600,
				});
			}
			const entry = codes.get(p.get("code") ?? "");
			codes.delete(p.get("code"));
			if (
				!entry ||
				entry.expires <= Date.now() ||
				p.get("grant_type") !== "authorization_code" ||
				p.get("client_id") !== CLIENT_ID ||
				createHash("sha256").update(p.get("code_verifier") ?? "").digest("base64url") !== entry.challenge
			) {
				return json(400, { error: "invalid_grant" });
			}
			return json(200, {
				token_type: "Bearer",
				access_token: ACCESS_TOKEN,
				refresh_token: REFRESH_TOKEN,
				expires_in: 3600,
			});
		}
		if (url.pathname === "/mcp" && request.method === "POST") {
			if (request.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
				response.setHeader(
					"WWW-Authenticate",
					`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="read"`,
				);
				return json(401, {});
			}
			let text = "";
			for await (const chunk of request) text += chunk;
			try {
				return json(200, rpc(JSON.parse(text)));
			} catch {
				return json(400, {});
			}
		}
		return json(404, {});
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture did not bind");
	issuer = `http://127.0.0.1:${address.port}`;
	return {
		url: `${issuer}/mcp`,
		issuer,
		calls,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
