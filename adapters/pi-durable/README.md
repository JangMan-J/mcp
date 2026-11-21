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

const host = await startDurableMcpHost({
  mcpConfig: './mcp.json',             // reads the mcpServers map
  databasePath: './mcp-calls.sqlite',  // reuse this file after restart
});
try {
  const registry = createRegistry();
  for (const extension of host.extensions) registry.install(extension);
  // Use the registry throughout the durable session.
} finally {
  await host.close();
}
```

`host.extensions` contains durable `Extension` objects: install them directly,
without converting MCP responses to strings or wrapping tool registrations.
Tool results expose content blocks for display and `structuredOutput` for
codemode. For a call outside the registry, use `host.call(key, name, args)`
with a stable key for that logical operation and a name from `host.toolNames`.
Reusing the database and key lets the host replay a committed result instead
of resending the request.

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

1. If the store holds a `completed` record for `key`, return its result
   without calling `send`. Replaying a completed call is answered from
   storage and is not a resend.
2. If the store holds an `intent` with no outcome, return
   `{ status: "interrupted" }` without calling `send`.
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

Re-issuing an interrupted call is a caller's explicit decision, made only
through the core request option `acceptDuplicate: true`, together with
`retryOf` naming the original request. A re-issued request always gets a
fresh request id; the stored id is never reused. Setting `acceptDuplicate`
means accepting that the remote may execute the effect a second time. Before
re-issuing, prefer a domain-specific read to reconcile whether the original
call was applied. Only operations known to be read-only, or a per-tool
operator override, should be treated as safe to replay.

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

- Restart replays committed outcomes and re-dispatches persisted handles;
  it does not resend interrupted calls (see `acceptDuplicate` above).
- The host's durable `restart_limit` is honored: restores are single
  dispatches, and neither this adapter nor the host may resend requests in a
  tight loop across crashes. Backoff and giving up after the limit are the
  host's responsibility; an exhausted limit leaves calls `interrupted` for
  an operator, not retried forever.
- Restart cannot recover an in-flight call whose outcome was never
  committed, cannot prove whether its remote effect happened, and cannot
  resume a subscription in place — it re-listens under a new request.
