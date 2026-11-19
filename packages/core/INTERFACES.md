# `@mcp-client/core` Interfaces (S1.0 Frozen)

Status: **FROZEN at S1.0**. Any post-S1.0 interface change must go through the director, update this document, bump the interface version, and re-run all conformance fixtures (`IMPLEMENTATION_PLAN.md` §16.2 & §16.7).

- **Interface Version:** `1.0.0`
- **Entry Point:** `packages/core/src/index.ts` (`@mcp-client/core`, no deep imports)
- **Runtime Neutrality:** Zero `node:*` imports or Node-only globals in `packages/core/src`.
- **Frozen Contracts:**
  - `jsonrpc.ts`: `JsonRpcRequest`, `JsonRpcNotification`, `JsonRpcResponse`, `JsonRpcErrorResponse`, `IdGenerator`, `assertOutboundRequest`, `parseInboundMessage`
  - `outcome.ts`: `Outcome<T>` (all 9 disjoint outcome kinds), `OutcomeMeta`, `UncertainWrite`, `TransportFailure`, `McpOutcomeError`, `unwrapOutcome`
  - `ports.ts`: `Transport`, `TransportCall`, `Exchange`, `ExchangeEnd`, `PortRegistry`, `Clock`, `ConsentPort`, `BrowserPort`, `RedirectPort`, `CredentialStore`, `IdentityPort`, `FetchPort`, `CacheStore`
  - `telemetry.ts`: `TelemetryPort`, `W3cTraceContext`, `validateTraceContext`
  - `auth-types.ts`: `AuthProvider`, `AuthChallenge`, `AuthHeaderResult`
  - `extension.ts`: `Extension`, `ExtensionHost`, `ExtensionRegistry`, `Disposable`
  - `request.ts` / `index.ts`: `McpClient`, `RequestManager`, `ClientRequest<T>`, `RequestOptions`, `StreamHandle`, `DEFAULT_LIMITS`
