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

## S1.1 additions (additive; frozen S1.0 contracts unchanged)

Wire lifecycle per `IMPLEMENTATION_PLAN.md` §5 and `docs/conformance/wire.md` rows `WIRE-*`, `VER-*`, `PROG-*`. All new exports come from `packages/core/src/index.ts`; still runtime-neutral.

- `progress.ts`: `ProgressRegistry` (`register`, `accept(params, expected?)`, `release`, `stats`), `ProgressToken`, `ProgressDecision`, `ProgressDropReason`, `ProgressStats`, `parseProgressParams`, `isProgressToken`, `progressTokenKey`, `NotificationQueue<T>` (single-consumer async push queue).
- `cancel.ts`: `DEFAULT_READ_ONLY_METHODS`, `createReadOnlyPredicate`, `isReadOnlyMethod`, `classifyInterruptedCall` / `InterruptedCall` / `InterruptClass` (uncertain-write classification hook), `uncertainEvidence`, `buildUncertainWrite`, `argsDigest`, `guardExchangeDone` / `GuardHooks` / `GuardedDone` (first settle wins, abort settles locally).
- `lifecycle.ts`:
  - constants `LIBRARY_CLIENT_INFO`, `META_LOG_LEVEL`, `DISCOVER_PROBE_TIMEOUT_MS` (10 s), `DIAGNOSTIC_EVIDENCE_MAX` (2 KiB); `validateCallerMeta` (WIRE-META-4/5 plus WIRE-LOG-1).
  - error mapping: `classifyJsonRpcError`, `JsonRpcErrorClass`, `JsonRpcErrorCategory`, `parseUnsupportedVersionData`, `UnsupportedVersionData`, `missingClientCapabilities`.
  - versions and diagnostics: `selectProtocolVersion`, `UnsupportedVersionDiagnostic`, `buildUnsupportedVersionDiagnostic`, `LifecycleContext`, `mapLifecycleOutcome`.
  - era: `EraState`, `classifyDiscoverOutcome`, `isCacheableEra`, `EraCache` (memory only, single-flight `resolve`).
  - transport layer: `LifecycleTransport` (progress registry, inbound notification policy, local settle on abort, late responses counted), `LifecycleTransportOptions`, `defaultNotificationFilter`, `NotificationVerdict`, `LifecycleHooks`, `defaultLifecycleHooks`, `WireStats`.
- `lifecycle.ts` client: `LifecycleClient` / `createLifecycleClient(opts)` composed over the frozen `RequestManager` (same `request`/`discover`/`use`/`close` surface as `McpClient`) plus `probe(opts?) => Promise<EraState>`, `era()`, `wireStats()`; `LifecycleClientOptions` (McpClientOptions fields plus `lifecycle?: LifecyclePolicyOptions` with `hooks`, `settleOnAbort`, `readOnlyMethods`, `progressRegistry`, `eraCache`), `ProbeOptions`.
- `index.ts`: only adds `export *` of `lifecycle.ts`, `cancel.ts`, `progress.ts`. `McpClient` / `McpClientOptions` are unchanged.

`LifecycleClient` behavior relative to `McpClient`:

- wraps the transport in `LifecycleTransport`. Core still never writes `notifications/cancelled`; bindings do (stdio sends it, HTTP closes the stream).
- `clientInfo` defaults to `LIBRARY_CLIENT_INFO` when neither `clientInfo` nor `ports.identity` is given (WIRE-META-3); `false` omits it.
- `RequestOptions.idempotent` defaults to `isReadOnly(method)`, so interrupted reads are `cancelled` / `transport-failure` and interrupted writes are `uncertain-write` (N14).
- a `-32022` with no mutual version, or failing again after the single retry, settles as `unsupported-version` with an `UnsupportedVersionDiagnostic` in `detail` (VER-3, VER-4).
- era probing is explicit (`probe()`), not automatic before the first request; hosts or bindings wanting VER-5 / STDIO-DISC-1 probe-on-first-use call `probe()` first.

## Post-S1.1 additions (additive and optional; no existing member removed or made required)

All from `packages/core/src/index.ts`; still runtime-neutral. Existing implementers of the S1.0 ports compile unchanged because every new member is optional.

- `auth-types.ts`:
  - new `AuthRequestContext` (`signal`, `consent?`, `serverLabel?`) passed as an optional trailing argument to `AuthProvider.headerFor(url, operation?, context?)` and `onChallenge(challenge, signal, context?)`.
  - new `AuthError(kind: "auth-failure" | "auth-unavailable", reason)`; `reason` is structured and never carries peer or credential text.
  - `AuthProvider.stepUpLimit?` (max 403 replays per exchange, default 3); `AuthHeaderResult.credentialVersion?` and `AuthChallenge.credentialVersion?` (opaque identity of the credential on the wire; `null` means no Authorization header was sent).
- `bearer-challenge.ts` (new, re-exported): `BearerChallenge`, `parseBearerChallenges(input)`.
- `outcome.ts`: `TransportFailureKind` adds `auth-failure`, `auth-unavailable`; `TransportFailure.reason?`; `UncertainWrite.taskHandle?` (HTTP-AMBIG-4); `OutcomeMeta.retryOf?` (HTTP-AMBIG-3).
- `ports.ts`: `TransportCall.consent?`, `TransportCall.serverLabel?`; `Exchange.abortDelivery?()` (delivery evidence when interrupted before `done` settles); `ConsentPrompt.kind` adds `authorize`, `client-info`, plus optional `issuer`, `issuerHost`, `resource`, `scopes`, `redirectUri`, `redirectHost`, `localhostWarning`.
- `request.ts`: `RequestOptions.acceptDuplicate?` / `retryOf?` (opt-in re-issue; `retryOf` without `acceptDuplicate: true` settles `local-error` `accept-duplicate-required`); `RequestManager` options `serverLabel?`. Over `maxInFlight`, requests now wait in a FIFO admission queue instead of failing; aborting while queued settles `cancelled` with `wasSent: false`, `phase: "queue"` (LIM-CONC-1).
- `progress.ts`: `ProgressThrottle<T>(clock, emit, limit = 50, windowMs = 1000)`: sliding-window throttle for progress callbacks that coalesces to the latest value and flushes it before settle (LIM-PROG-1).
- `cancel.ts`: `guardExchangeDone` uses `abortDelivery()` when the exchange provides it; the local-abort message no longer includes the abort reason.
- `McpClient` and `LifecycleClient` pass `server.label ?? server.key` as `serverLabel` to the `RequestManager`.
