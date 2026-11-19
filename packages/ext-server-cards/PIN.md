# Pin: MCP Server Cards (SEP-2127)

| Field | Value |
|---|---|
| Upstream | `modelcontextprotocol/ext-server-card` |
| Commit | `28db12c9b4a379489d46e49bf1bd4a991f05c9b7` |
| Paths | `docs/discovery.md`, `schema.json` |
| SEP review snapshot | `526201bbc80231daa40ffcdecfc9da4e54e5dc93` |
| Core spec | `2026-07-28` |
| Default | advisory only; no client capability advertised |

## Notes (EXT-PIN-1)

- EXT-card-10 / Q20 stage conflict: the extensions overview says `Beta`; pinned `docs/discovery.md` says `Protocol Revision: draft`. Status: open, unresolved. No fixture targets EXT-card-10.
- Cards are advisory. Live `server/discover` always wins (EXT-card-4). `tools`/`resources`/`prompts` in a card are ignored (EXT-card-3).
