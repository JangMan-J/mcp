# @jangmanj/mcp-client

MCP 2026-07-28 client library: core protocol/lifecycle, stdio and HTTP transports, OAuth/client-credentials auth, ops (tools/prompts/resources/completion), MRTR/cache/tasks, OpenTelemetry, and extensions.

## Installation

```sh
npm install @jangmanj/mcp-client
```

## Subpath exports

- `@jangmanj/mcp-client` (re-exports `./core`)
- `@jangmanj/mcp-client/core`
- `@jangmanj/mcp-client/auth`
- `@jangmanj/mcp-client/ops`
- `@jangmanj/mcp-client/mrtr-cache`
- `@jangmanj/mcp-client/telemetry-otel`
- `@jangmanj/mcp-client/transport-http`
- `@jangmanj/mcp-client/transport-stdio`
- `@jangmanj/mcp-client/ext-events`
- `@jangmanj/mcp-client/ext-server-cards`
- `@jangmanj/mcp-client/ext-skills`

## TypeScript

- Use `"moduleResolution": "NodeNext"` (or `"Bundler"`) in your consumer `tsconfig.json` so subpath exports resolve cleanly.
- If your consumer `tsconfig.json` overrides `"lib"` without `"DOM"` (for example `"lib": ["ES2023"]`), install `@types/node` and include `"types": ["node"]` so standard Web/Node globals (`AbortSignal`, `URL`, `Response`, `CryptoKey`) are typed.

## Pi extension

This package doubles as a [Pi](https://pi.dev) package: installing it registers an
extension that replaces Pi's built-in MCP session support with a bridge built on
this library (transports, lifecycle, ops, MRTR) and exposes each server's tools to
Pi as `mcp__<server>__<tool>`.

```sh
pi install npm:@jangmanj/mcp-client
# or from a checkout / git ref:
pi install ./path/to/mcp-client
pi install git:github.com/JangMan-J/mcp-client@v0.1.1
```

The extension reads the same `mcp.json` files as built-in MCP
(`$PI_CODING_AGENT_DIR/mcp.json` or `~/.pi/agent/mcp.json`, plus `.pi/mcp.json` in
trusted projects) with the same merge, interpolation (`${VAR}`, `!command`), and
exposure rules (`codemode` default, `direct`/`deferred`/`hidden`, `toolExposure`
patterns). `/mcp` lists server states; `/mcp reconnect <name>` restarts one.
Servers registered by other extensions via `pi.registerMcpServer()` are connected
too, with file configuration taking precedence.

Not supported yet: OAuth flows (`oauth` entries connect unauthenticated and will
fail on servers that require it — use `headers` with a token instead), MCP
prompts/resources, elicitations, and task-based tool calls.

A running Pi session picks the extension up on `/reload`; fresh starts load it
automatically.

## Development

```sh
npm run check
npm run smoke:pack
```
