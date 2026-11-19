# MCP Apps (EXT-PIN-1)

`io.modelcontextprotocol/ui` is stable. The protocol implementation targets
`modelcontextprotocol/ext-apps` at `ea3e9d0e624a20bc1c51310292f09d9b8ed17161`,
`specification/2026-01-26/apps.mdx`.

EXT-apps-BRIDGE: the `ui/*` postMessage/iframe bridge is excluded (deferred,
 host-owned). Hosts supply rendering through `AppRenderPort`.
