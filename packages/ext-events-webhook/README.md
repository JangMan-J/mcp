# @mcp-client/ext-events-webhook

**Stage: draft — OFF BY DEFAULT; explicit second opt-in required.**

Isolated receiver for SEP-3415 webhook delivery (Standard Webhooks profile). It is a separate
package and a separate process-capable unit: the local client runtime never opens a listen socket.
This package does not depend on `@mcp-client/ext-events`.

## Pieces

- `ListenerPort` — host-owned inbound HTTP listener. Bind address, port and TLS termination are host
  decisions. `bindListener` refuses any callback URL that does not start with `https://`
  (EXT-events-18, EXT-events-25).
- `createWebhookHandler` — verifies `webhook-id` / `webhook-timestamp` / `webhook-signature` over the
  raw body bytes (HMAC-SHA256 keyed by the base64 after `whsec_`, `v1` tokens only, any of several
  space-delimited tokens, any configured secret for rotation, constant-time compare, timestamps older
  than 5 minutes rejected) **before** parsing JSON (EXT-events-20..22). After verification it echoes
  `verification` challenges (EXT-events-23), records `gap` / `terminated` control envelopes
  (EXT-events-12, EXT-events-24), and appends event occurrences to an `EventSink`.
- `BoundedEventSink` — append-only, bounded `EventSink` that is also an `EventSource` for pull.
  Idempotent on `(subscriptionId, eventId)` (EXT-events-27). Event `data` is stored verbatim as
  untrusted data and is never executed or interpolated (EXT-events-30).

## Delivery guarantee

Delivery is at-least-once from the sender, deduplicated by `eventId` at the sink. This package does
not provide or claim exactly-once delivery (EXT-events-28).

## Risk note

Enabling webhooks means accepting inbound HTTP from the network. Keep it off unless the host needs it,
terminate TLS in front of the listener, keep `whsec_` secrets out of logs, and treat every payload as
untrusted input.
