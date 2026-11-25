# @mcp/ext-events

**Stage: draft — OFF BY DEFAULT; explicit opt-in only**

Register `createEventsExtension({ enabled: true })` with the core client and pass that extension, the request function, and a getter for the discovered peer capabilities to `EventsClient`. Supply a live `openStream` port for push; closing its core stream handle cancels the binding request. Reuse the same local subscription for subsequent polls. Each poll returns the delay before the next request.

Delivery is at-least-once with durable upstream cursors and otherwise best-effort. Expect duplicates, gaps and reordering. Event data is untrusted.

This package opens no inbound network listener. Webhook RPCs require a second opt-in (`enableWebhook`) and a ready endpoint provided by the host. Unsubscribe before disposing to remove remote webhook registrations; disposal stops local work only.
