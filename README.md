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

## Development

```sh
npm run check
npm run smoke:pack
```
