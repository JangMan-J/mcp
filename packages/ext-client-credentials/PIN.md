# Pin: OAuth Client Credentials extension

| Field | Value |
|---|---|
| Upstream | `modelcontextprotocol/ext-auth` |
| Commit | `15ca394e00a66434520b9ade26294999295a43ae` (2026-10-23) |
| Path | `specification/stable/oauth-client-credentials/2026-07-28/oauth-client-credentials.mdx` |
| Stage | `stable` |
| Core spec | `2026-07-28` (`5f5440bb26a62e2cf3440b92da5a667efa03b267`) |
| Extension id | `io.modelcontextprotocol/oauth-client-credentials` |
| Default | disabled; advertised only when configured and working |

## Tag vs wiki notes (EXT-PIN-1)

- JWT `aud`: the tag docs say token endpoint URL; the wiki mirror says the issuer as the only value (RFC 10070). The ext-auth page is silent. This package signs `aud` as the single validated AS `issuer` string, never the token endpoint URL. The choice is a client policy, not a pinned requirement (EXT-cc-5 stays unresolved).
- JWT grant shape: the tag diagram shows the RFC 7523 s2.1 grant (`assertion`). The wiki and the ext-auth page use `client_credentials` with `client_assertion` (RFC 7523 s2.2). This package uses the latter, with no `client_id` body parameter.
- Rows EXT-cc-PIN, EXT-cc-1, -2, -3, -5, -6 are unresolved, so their behavior is covered by package tests, not by `.exchange.json` fixtures.
