# pi-durable

Typed durable host integration for MCP calls made through Pi: commit a call's
intent before sending it, replay committed outcomes from storage, and surface
— never silently resolve — calls whose remote effect is unknown after a
restart.

## Install the built host in a durable registry

From the repository root, run `npm run build` to build the workspace packages,
then `npm run build:pi-durable` to emit `adapters/pi-durable/dist/index.js` and
its type declarations. The adapter is not a root workspace; the consuming
application supplies `@earendil-works/pi-durable@1.6.0`.

```js
import { createRegistry } from '@earendil-works/pi-durable';
import { startDurableMcpHost } from './adapters/pi-durable/dist/index.js';

async function withMcpRegistry(run, { signInServer, authorizationConsent } = {}) {
  const host = await startDurableMcpHost({
    mcpConfig: './mcp.json',
    databasePath: './mcp-calls.sqlite',
    authorizationConsent, // application's OAuth consent port, if needed
  });
  try {
    if (signInServer) await host.signIn(signInServer);
    const registry = createRegistry();
    for (const extension of host.extensions) registry.install(extension);
    return await run(registry, host);
  } finally {
    await host.close();
  }
}
```

- **Servers:** `mcpConfig` names an operator-selected JSON file containing an
  `mcpServers` map. Alternatively, pass `servers` as an array of named
  descriptors, e.g. `{ name: 'remote', url: 'https://example.com/mcp' }` for
  Streamable HTTP or `{ name: 'local', command: 'node', args: ['./server.js'] }`
  for stdio. If both options are set, explicit entries replace same-name file
  entries. Disabled entries are skipped.
- **Storage:** Reuse `databasePath` across restarts for call records, event
  cursors and persisted handles. Without it, SQLite is in-memory. `stateDir`
  is separate: it holds credentials and caches, defaults to
  `${databasePath}.state` for a file database, and otherwise defaults to a
  private temporary directory removed on close. Do not use Pi's global
  directory as `stateDir`.
- **Sign-in:** A server that requires authorization may be listed in
  `host.servers` without any tools. For interactive OAuth, supply
  `authorizationConsent` (and optionally a `browser` port), wait for
  `host.signIn(serverId)` to finish rediscovery, then read and install
  `host.extensions`. No sign-in call is needed for an already accessible server.

`host.extensions` contains durable `Extension` objects: install them directly.
Tool results expose `output` content blocks for display and `structuredOutput`
for codemode.

### Names and replay

The default `toolNaming: 'prefixed'` usually registers ordinary tools as
`mcp__<server>__<tool>`. Use `host.toolNames` for the exact names, including
hash-suffixed variants. `toolNaming: 'bare'` keeps wire names and requires them
not to collide with other registered tools. Feature names such as `mcp_prompts`
and `mcp_resources` are unchanged.

Outside the registry, call `host.call(key, name, args)` with an optional fourth
argument, an `AbortSignal`. To replay a committed result without resending,
reopen the same database and reuse the key, tool and arguments. Give distinct
logical calls distinct keys. An unfinished call is not replayed by default.
Set `readOnlyTools` (host-wide or per server)
using wire names for tools known to be read-only. Per-server `toolOverrides`
(`'replay'` or `'interrupt'`) take precedence over `readOnlyTools` and
`acceptDuplicate`. See [Tool calls](#tool-calls-durablecalls) for the risks.

### Mixed servers, features and cancellation

Stdio and HTTP servers can share one host. Feature tools take an `action` and a
`server` ID; pass the ID explicitly when mixing servers, for example:

```js
const controller = new AbortController();
const pending = host.call('notes-list-1', 'mcp_resources',
  { server: 'remote', action: 'list' }, controller.signal);
// To request cancellation, call controller.abort().
const result = await pending;
```

Use an `AbortController` per call outside the registry. Registry execution
uses its context signal, and the registration's `cancel` aborts the active
invocation. Both paths apply to ordinary and feature tools. Cancellation does
not prove the remote stopped or undo a side effect. To cancel an existing task
or remove a subscription, use the corresponding feature action (`cancel` or
`unsubscribe`). `host.close()` aborts active calls and closes streams and
transports.

### Refreshing the registry snapshot

For servers advertising `tools.listChanged`, `notifications/tools/list_changed`
refreshes the host's snapshot asynchronously, not the installed registry.
To refresh explicitly, `await host.refreshTools(serverId)` (omit the ID for
all servers). After refresh or sign-in, read
`host.extensions` again and install the current snapshot into a fresh registry
for the next session or at a safe application boundary. Keeping the old
registry can leave removed tools registered.

## Lower-level modules

| Module | Owns |
| --- | --- |
| `calls.ts` | `DurableCalls`: per-key intent/outcome commits around a send |
| `handles.ts` | `DurableHandles`, `DurableHandle`: persisted task, MRTR, and subscription handles |
| `events.ts` | `ConversationEvents`: per-subscription event log and cursor (Events streams only) |
| `policies.ts` | `applyIdempotencyPolicy`: opt-in idempotency-key injection |
| `nested-key.ts` | `nestedCallKey`: stable keys for nested calls |

## What a checkpoint cannot prove

A local checkpoint records what this host committed to its own storage. It
cannot prove what happened remotely:

- **Intent committed, no outcome** — the request may never have been sent,
  may have been sent and lost in transit, or may have been fully applied by
  the remote before the host crashed. All three look identical locally.
- **Outcome committed** — proves the host received and recorded a result. It
  says nothing about later remote state.
- **Event cursor committed** — proves the event was recorded locally first
  (see Cursors). It does not prove the remote will not deliver it again.

Because of this, this adapter makes no exact-once promise. Duplicates remain
possible; the contracts below exist to make them explicit choices instead of
accidents.

## Tool calls (`DurableCalls`)

`execute(key, request, send)` runs under a per-key lock and follows one rule:
commit before wake.

1. If the store holds a matching `completed` record for `key`, return its
   result without calling `send`.
2. If the store holds a matching `intent` with no outcome, return
   `{ status: "interrupted" }` without calling `send` unless restart policy
   allows another attempt.
3. Otherwise commit the intent, then call `send`, then commit the outcome,
   then return the result. Host-visible effects happen only after the outcome
   is committed.

Keys are stable per logical call: use the caller-supplied key, or derive a
nested key with `nestedCallKey(parent, child)` — by explicit child key, or by
position for positional siblings. A replay of the same logical call reuses
the same key; distinct logical calls must not share one.

### The unsafe default, and explicit `acceptDuplicate`

`tools/call` is not replay-safe by default. A write whose outcome was never
committed may already have taken effect remotely, so resending it can apply
the effect twice. The default handling of an `interrupted` call is therefore
to stop and surface it as an uncertain write — never to resend automatically,
including on restart.

The host's `acceptDuplicate: true` option (host-wide or per server) permits
resending an unfinished call with a fresh request ID, within `restartLimit`.
This may execute a remote effect a second time. Prefer a domain-specific read
to reconcile whether the original call was applied. Use a `'replay'` override
only when you intend to allow reissuing that tool.

An injected idempotency key does not change this rule: it helps a remote
dedupe a retry, but it is not authorization to retry a write.

### Idempotency keys (`applyIdempotencyPolicy`)

Injection is opt-in per tool and conservative:

- A policy matches one `serverId` + `toolName` pair; no match, no injection.
- The tool's input schema must declare the policy's field as a `string`
  property; undeclared or non-string fields are left alone.
- A caller-supplied value for the field is never replaced.
- The caller's `args` object is never mutated; injection returns a copy.
- The injected value is the call's `logicalKey`, assigned once per logical
  call, so it is stable across transport attempts of that call.

## Handles (`DurableHandles`)

The host owns persistence and transport; this module owns handle shape and
dispatch. A `DurableHost` supplies `storage.read()` / `storage.write(data)`
for one snapshot value, `send(request)` for transport, and optionally
`newId()` and `now()`.

Three handle kinds are persisted as plain data:

- `task` — `{ taskId, expiresAt? }`. Dispatch sends `tasks/get` with a fresh
  request id. An expired handle (`now() >= expiresAt`) fails instead of
  sending.
- `mrtr` — `{ id, method, requestState, inputRequests }`. Dispatch retries
  the stored method with the persisted `requestState` and `inputRequests`,
  under a fresh, distinct request id — never the stored `id`.
- `subscription` — `{ subscriptions }`. Dispatch re-sends
  `subscriptions/listen` with a fresh descriptor. There is deliberately no
  resume field: a subscription is re-established, not resumed.

`parseHandle` validates unknown snapshot data and returns `null` for anything
that is not a well-formed handle; `save` rejects invalid handles, and
`restore()` returns `null` when no valid handle is stored. Handles persist
identifiers and request state only — no credentials or transport state.

## Cursors (`ConversationEvents`)

Only for an enabled Events stream, delivering in order per subscription:

- Events are recorded in the conversation first, deduplicated by
  `(subscription, eventId)`; the cursor advances only after that commit.
  Delivery requires autocommit — the two commits are separate on purpose.
- A crash between the event commit and the cursor commit redelivers the
  event; it cannot skip it. A duplicate may finish an interrupted cursor
  checkpoint only while it is the latest recorded event for the
  subscription, and replaying an older event never rewinds the cursor.
- Cursor strings are opaque: stored and compared, never parsed.

## Restart limits

- Restart replays committed outcomes and does not resend interrupted calls
  by default. The host's `restartLimit` caps resends per call (one by default
  when replay is allowed). An exhausted limit leaves the call `interrupted`.
- Restart cannot recover an uncommitted outcome or prove whether the remote
  effect happened. A subscription handle re-listens under a new request
  rather than resuming in place.
