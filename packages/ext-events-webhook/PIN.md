# Pin: Events webhook receiver (SEP-3415, Standard Webhooks profile)

| Field | Value |
|---|---|
| Upstream | SEP-3415 events extension, `W/seps/3415-events-extension.md` |
| Mirror commit | `4165cc2e580afa795842002f631edbbe17c63757` |
| Observed PR head | `60b15c16f2e7265ea34ac51099dc5be62f734692` |
| Profile | Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` `v1,<base64>`) |
| Stage | `draft` |
| Extension id | `io.modelcontextprotocol/events-webhook` |
| Default | disabled; second explicit opt-in required |

## Notes (EXT-PIN-1)

- Rows covered by fixtures: EXT-events-12, -20, -21, -22, -23, -24, -25, -27, -30.
- Rows EXT-events-8, -9 and EXT-events-ERR-1 are not targeted by this package's fixtures.
