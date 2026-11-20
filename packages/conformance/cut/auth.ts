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
 * Known gaps (flagged at runtime, never emulated):
 *  - `token-endpoint-auth-{basic,post,none}`: the public
 *    `OAuthOptions` surface exposes no token-endpoint client-auth
 *    method selector, so the CUT cannot force basic vs post vs none;
 *    the library's registered-credential behaviour decides.
 *  - A non-loopback authorization endpoint cannot be driven headlessly:
 *    opening a real system browser would hang the runner, so the
 *    browser port throws instead of pretending to browse.
 *  - A supplied `redirect_uri` that is not the loopback listener this
 *    process can bind cannot receive a callback; `startLoopbackRedirect`
 *    binds an ephemeral port and cannot adopt a caller-chosen one.
 */
import {
  AuthError,
  ConfiguredBearer,
  OAuthAuthorization,
  SafeFetch,
  canonicalResource,
  startLoopbackRedirect,
  type AuthorizationConsent,
  type OAuthOptions,
} from "@mcp-client/auth";
import { HttpTransport } from "@mcp-client/transport-http";

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
  const allowInsecureDev = serverUrl.protocol === "http:";
  const safeFetch = new SafeFetch({ allowInsecureDev, allowAddress: (_host, ip) => isLoopbackHost(ip) });

  const clientId = stringField(context, "client_id");
  const clientSecret = stringField(context, "client_secret");
  const clientMetadataUrl = stringField(context, "client_metadata_url");
  const suppliedRedirectUri = stringField(context, "redirect_uri");
  const accessToken = stringField(context, "access_token");
  const toolName = stringField(context, "tool_name") ?? "test_tool";

  if (scenario === "auth/basic-cimd" && clientMetadataUrl === undefined) {
    throw new CutAuthGapError(
      'auth/basic-cimd requires documented context field "client_metadata_url"; absent, and CIMD is not emulated',
    );
  }
  if (scenario.startsWith("auth/token-endpoint-auth-") && clientId === undefined) {
    throw new CutAuthGapError(
      `${scenario}: public OAuthOptions exposes no token-endpoint client-auth method selector ` +
        'and no documented "client_id" was supplied; refusing to emulate token-endpoint authentication',
    );
  }
  if (scenario.startsWith("auth/token-endpoint-auth-")) {
    if (accessToken !== undefined || (scenario.endsWith("-none") !== (clientSecret === undefined))) {
      throw new CutAuthGapError(`${scenario}: requires OAuth credentials matching the peer's advertised method`);
    }
  }

  // The redirect listener is a real library port; bind it before the
  // provider can need a redirect URI to register.
  const redirect = accessToken === undefined ? await startLoopbackRedirect() : undefined;
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
          throw new CutAuthGapError(`${scenario}: provider requested registration but context has no client_id (no dynamic registration port)`);
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
            ...(clientMetadataUrl !== undefined
              ? { cimd: { clientIdUrl: clientMetadataUrl, redirectUris: [redirectUri] } }
              : {}),
            ...(scenario === "auth/offline-access-scope" ||
            scenario === "auth/offline-access-not-supported"
              ? { offlineAccess: true }
              : {}),
          });

    const transport = new HttpTransport({ url, authProvider: provider });
    try {
      const end = await transport.start(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: toolName, arguments: {} },
        },
        {
          idempotent: false,
          signal: AbortSignal.timeout(30_000),
          timeoutMs: 30_000,
        },
      ).done;
      if (end.kind === "failure") {
        const reason =
          "reason" in end.failure ? `/${String(end.failure.reason)}` : "";
        throw new Error(
          `runAuth ${scenario}: request failed (${end.failure.kind}${reason}, ` +
            `status ${String(end.failure.status)}, delivery ${end.delivery})`,
        );
      }
      if ("error" in end.message) {
        throw new Error(
          `runAuth ${scenario}: JSON-RPC error ${end.message.error.code}: ${end.message.error.message}`,
        );
      }
    } finally {
      await transport.close();
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
