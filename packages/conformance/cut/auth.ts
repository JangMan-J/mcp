/**
 * Client-under-test: official-runner `auth/*` scenarios (25 scenarios).
 *
 * Drives the real libraries end to end: `OAuthAuthorization` /
 * `ConfiguredBearer` from `@mcp-client/auth` (discovery, PKCE, consent,
 * token exchange, step-up) behind `HttpTransport` from
 * `@mcp-client/transport-http`, which owns 401/403 retry on the wire.
 * Nothing about OAuth is reimplemented here; this module only supplies
 * the host ports the library requires (consent, browser, redirect) for a
 * headless, loopback-only test peer.
 *
 * Contract (from the dealer, pending Ring 1's exact context examples):
 *  - Resolves `Promise<void>` only when an authenticated MCP request
 *    completes with a JSON-RPC result.
 *  - Throws on every failure (auth failure, transport failure, JSON-RPC
 *    error, unsupported scenario, missing context, library gap).
 *  - `context` is the runner's `MCP_CONFORMANCE_CONTEXT` JSON object.
 *    Only documented OAuth field names are read, exactly as spelled:
 *    `client_id`, `client_secret`, `client_metadata_url`,
 *    `redirect_uri`, `access_token`, `tool_name`. No aliases.
 *  - Consent and the browser port are restricted to the supplied server
 *    / loopback test peer. Consent for an arbitrary authorization
 *    server is never granted.
 *
 * Host ports supplied here (the library has no equivalent):
 *  - Client registration only from the runner's pre-registered
 *    `client_id`/`client_secret` (consent port "client-info" prompt) or
 *    CIMD; never dynamic client registration. Otherwise fail closed.
 *  - A reusable loopback redirect listener (the library's is single use,
 *    but step-up and AS migration need a second interactive flow).
 *
 * Known gaps (flagged at runtime, never emulated):
 *  - A non-loopback authorization endpoint cannot be driven headlessly:
 *    opening a real system browser would hang the runner, so the
 *    browser port throws instead of pretending to browse.
 *  - A supplied `redirect_uri` that is not this process's loopback
 *    listener cannot receive a callback.
 */
import {
  AuthError,
  ConfiguredBearer,
  OAuthAuthorization,
  SafeFetch,
  canonicalResource,
  type RedirectPort,
  type AuthorizationConsent,
  type OAuthOptions,
} from "@mcp-client/auth";
import { createServer } from "node:http";
import { McpClient } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";

const VERSION = "2026-07-28";

/** A real library/context gap: reported as such, never worked around. */
export class CutAuthGapError extends Error {
  override readonly name = "CutAuthGapError";
}

const SCENARIOS = new Set([
  "metadata-default", "metadata-var1", "metadata-var2", "metadata-var3", "basic-cimd",
  "scope-from-www-authenticate", "scope-from-scopes-supported", "scope-omitted-when-undefined",
  "scope-step-up", "scope-retry-limit", "token-endpoint-auth-basic", "token-endpoint-auth-post",
  "token-endpoint-auth-none", "pre-registration", "resource-mismatch", "offline-access-scope",
  "offline-access-not-supported", "authorization-server-migration", "iss-supported",
  "iss-not-advertised", "iss-supported-missing", "iss-wrong-issuer", "iss-unexpected",
  "iss-normalized", "metadata-issuer-mismatch",
].map(name => `auth/${name}`));

const DEFAULT_CLIENT_METADATA_URL = "https://conformance-test.local/client-metadata.json";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

function requirePeer(url: URL): void {
  if (!isLoopbackHost(url.hostname) || !["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new CutAuthGapError("auth CUT requires an HTTP(S) loopback peer without URL credentials");
  }
}

function stringField(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new CutAuthGapError(`context field "${key}" must be a non-empty string`);
  }
  return value;
}

/**
 * Reusable loopback redirect listener. The library's `startLoopbackRedirect`
 * is single use, but step-up and authorization-server migration run a second
 * interactive flow with the same registered redirect_uri, so the CUT supplies
 * its own host `RedirectPort`: one listener, one pending wait at a time.
 */
async function startReusableRedirect(): Promise<RedirectPort & { readonly redirectUri: string; close(): void }> {
  let pending: ((params: URLSearchParams) => void) | undefined;
  const server = createServer((request, response) => {
    const target = request.url ?? "";
    if (request.method !== "GET" || !target.startsWith("/callback?") || !pending) {
      response.writeHead(404).end();
      return;
    }
    const resolve = pending;
    pending = undefined;
    response.writeHead(200, { "Content-Type": "text/plain" }).end("Authorization response received.");
    resolve(new URLSearchParams(target.slice("/callback?".length)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new CutAuthGapError("redirect listener has no port");
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  return {
    redirectUri,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
    waitForCallback(options) {
      if (options.redirectUri !== redirectUri) throw new CutAuthGapError("redirect_uri is not this listener");
      return new Promise<URLSearchParams>((resolve, reject) => {
        pending = resolve;
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      });
    },
  };
}

/**
 * One authenticated MCP request against `url`. A `tools/call` is the
 * request that exercises bearer placement, 401 retry and 403 step-up;
 * the tool name defaults to the conformance peer's `test_tool` unless
 * the documented context field `tool_name` names another.
 */
export async function runAuth(
  url: string,
  scenario: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!SCENARIOS.has(scenario)) {
    throw new CutAuthGapError(`runAuth does not handle scenario "${scenario}"`);
  }
  const serverUrl = new URL(url);
  requirePeer(serverUrl);
  const allowInsecureDev = true; // loopback runner
  const safeFetch = new SafeFetch({ allowInsecureDev, allowAddress: (_host, ip) => isLoopbackHost(ip) });

  const clientId = stringField(context, "client_id");
  const clientSecret = stringField(context, "client_secret");
  const clientMetadataUrl = stringField(context, "client_metadata_url");
  const suppliedRedirectUri = stringField(context, "redirect_uri");
  const accessToken = stringField(context, "access_token");
  const toolName = stringField(context, "tool_name") ?? "test_tool";

  // The redirect listener is a real library port; bind it before the
  // provider can need a redirect URI to register.
  const redirect = accessToken === undefined ? await startReusableRedirect() : undefined;
  try {
    if (suppliedRedirectUri !== undefined && suppliedRedirectUri !== redirect?.redirectUri) {
      throw new CutAuthGapError(
        `context "redirect_uri" (${suppliedRedirectUri}) cannot receive a callback in this process; ` +
          "startLoopbackRedirect binds an ephemeral loopback port and cannot adopt a caller-chosen one",
      );
    }
    const redirectUri = redirect?.redirectUri ?? suppliedRedirectUri ?? url;

    const consent: AuthorizationConsent = {
      async request(prompt) {
        if (prompt.kind === "client-info") {
          requirePeer(new URL(prompt.issuer));
          // Pre-registration from documented context fields only.
          if (clientId !== undefined) {
            return {
              decision: "accept",
              registration: {
                clientId,
                ...(clientSecret !== undefined ? { clientSecret } : {}),
                redirectUris: [redirectUri],
              },
            };
          }
          // No dynamic client registration: without a pre-registered client
          // (and no CIMD advertised by the AS) the scenario fails closed.
          throw new CutAuthGapError(
            `${scenario}: no pre-registered client_id in context and ${prompt.issuer} offers no CIMD; ` +
              "dynamic client registration is not supported",
          );
        }
        // Authorize prompts: grant only for this server's resource and
        // only when the issuer is the loopback test peer or the server
        // host itself. Anything else is an arbitrary authorization
        // server and consent is declined, never auto-granted.
        const resourceOk = prompt.resource === canonicalResource(url) || prompt.resource === url;
        const issuerOk = isLoopbackHost(prompt.issuerHost);
        if (!resourceOk || !issuerOk) return { decision: "decline" };
        return { decision: "accept" };
      },
    };

    const browser: NonNullable<OAuthOptions["browser"]> = {
      async open(input, signal) {
        // Headless browser port for the loopback test peer only: fetch
        // the authorization URL and follow redirects over real HTTP,
        // delivering the final redirect to the loopback callback
        // listener. A remote authorization page is a real gap (a system
        // browser cannot be driven by the runner), not emulated.
        let current = new URL(input);
        for (let hop = 0; hop < 5; hop++) {
          requirePeer(current);
          const response = await fetch(current, { redirect: "manual", signal });
          const location = response.headers.get("location");
          if (response.status >= 300 && response.status < 400 && location !== null) {
            const next = new URL(location, current);
            const callback = new URL(redirectUri);
            if (next.origin === callback.origin && next.pathname === callback.pathname) {
              requirePeer(next);
              await fetch(next, { redirect: "manual", signal });
              return;
            }
            current = next;
            continue;
          }
          throw new CutAuthGapError(
            `authorization endpoint returned HTTP ${response.status} without a redirect to the ` +
              "registered redirect_uri; interactive login is not part of the documented context",
          );
        }
        throw new CutAuthGapError("authorization redirect chain exceeded 5 hops");
      },
    };

    const provider =
      accessToken !== undefined
        ? new ConfiguredBearer({ resource: url, token: accessToken, allowInsecureDev })
        : new OAuthAuthorization({
            resource: url,
            redirectUri,
            allowInsecureDev,
            flowTimeoutMs: 20_000,
            fetch: {
              fetch(input, init) {
                // allowAddress only relaxes SafeFetch's blocklist. Check the host
                // separately and forbid internal redirects to unchecked hosts.
                requirePeer(new URL(input));
                return safeFetch.fetch(input, { ...init, redirect: "error" });
              },
            },
            consent,
            browser,
            ...(redirect ? { redirect } : {}),
            // The runner supplies no client_metadata_url; used only when the
            // authorization server advertises CIMD support.
            cimd: { clientIdUrl: clientMetadataUrl ?? DEFAULT_CLIENT_METADATA_URL, redirectUris: [redirectUri] },
            ...(scenario === "auth/offline-access-scope" ||
            scenario === "auth/offline-access-not-supported"
              ? { offlineAccess: true }
              : {}),
          });

    // McpClient stamps the per-request _meta (protocolVersion, capabilities)
    // the stateless 2026-07-28 lifecycle requires; HttpTransport owns the
    // 401/403 retry through the auth provider.
    const mcp = new McpClient({
      transport: new HttpTransport({ url, authProvider: provider, protocolVersion: VERSION }),
      server: { key: url },
      supportedVersions: [VERSION],
      clientInfo: { name: "mcp-client-conformance-cut", version: "0.1.0" },
    });
    try {
      // Migration is only observable on a request made after the first
      // authenticated one (the peer then moves PRM to a new authorization
      // server), so that scenario makes a second call.
      const calls = scenario === "auth/authorization-server-migration" ? 2 : 1;
      for (let call = 0; call < calls; call++) {
        const outcome = await mcp.request(
          "tools/call",
          { name: toolName, arguments: {} },
          { signal: AbortSignal.timeout(30_000), timeoutMs: 30_000 },
        );
        if (outcome.kind !== "ok") {
          throw new Error(`runAuth ${scenario}: ${JSON.stringify(outcome).slice(0, 500)}`);
        }
      }
    } finally {
      await mcp.close();
    }
  } catch (error) {
    if (error instanceof AuthError) {
      throw new Error(`runAuth ${scenario}: ${error.kind}/${error.reason}`, { cause: error });
    }
    throw error;
  } finally {
    redirect?.close();
  }
}
