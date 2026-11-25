# @jangmanj/mcp-client

MCP 2026-07-28 client library: core protocol/lifecycle, stdio and HTTP transports, OAuth/client-credentials auth, ops (tools/prompts/resources/completion), MRTR/cache/tasks, OpenTelemetry, and extensions.

## Installation

```sh
npm install @jangmanj/mcp-client
```

## Quickstart

```ts
import { McpClient } from "@jangmanj/mcp-client";
import { createOps } from "@jangmanj/mcp-client/ops";
import { StdioTransport } from "@jangmanj/mcp-client/transport-stdio";

const client = new McpClient({
  transport: new StdioTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }),
  server: { key: "filesystem" },
});

const ops = createOps(client);
const tools = await ops.tools.listAll();
if (tools.kind === "ok") {
  console.log(tools.value.items.map((t) => t.name));
  const result = await ops.tools.call("list_allowed_directories");
  if (result.kind === "ok") console.log(result.value.content);
}

await client.close();
```

Every call returns a discriminated `Outcome` (`ok` / `jsonrpc-error` / `transport-failure` /
`mrtr-interim` / …) instead of throwing — pattern-match on `kind`. HTTP servers use
`HttpTransport` from `/transport-http`; OAuth, bearer, and client-credentials live in
`/auth` (`OAuthAuthorization`, `ConfiguredBearer`, `ClientCredentialsAuth`).

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

Not supported yet: MCP prompts/resources exposure to Pi (servers offering only prompts or
resources connect but register nothing), elicitation UI (consent prompts decline by
default), task-based tool calls, and OAuth options `callbackPort`/`callbackUrl`/
`scope`/`authServerMetadataUrl` (the bridge uses an ephemeral loopback redirect and the
advertised scopes).

OAuth works out of the box for HTTP servers without a static `Authorization` header: the
first 401 marks the server "needs sign-in" in `/mcp`, and `/mcp login <name>` runs the
authorization-code + PKCE flow with CIMD/DCR registration through the system browser.
Credentials persist in `$PI_CODING_AGENT_DIR/mcp-client-oauth.json` (issuer-keyed);
`/mcp logout <name>` deletes them. Static clients can be set with
`"oauth": { "clientId": "...", "clientSecret": "${SECRET}", "clientName": "..." }`.

A running Pi session picks the extension up on `/reload`; fresh starts load it
automatically.

## Development

```sh
npm run check
npm run smoke:pack
npm run gen:spec-matrix   # regenerate SPEC.md (requirement ID -> source -> tests)
npm run check:spec-drift  # compare the vendored schema + spec prose against upstream
```

SPEC.md is the generated traceability matrix; CI fails when it is stale or a source
requirement ID is cited by no test and not exempted. `spec-drift.yml` (daily cron)
opens an issue when the upstream MCP 2026-07-28 schema or spec prose moves.
