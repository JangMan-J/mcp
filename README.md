# @jangmanj/mcp-client

MCP 2026-07-28 client library: core protocol/lifecycle, stdio and HTTP transports, OAuth/client-credentials auth, ops (tools/prompts/resources/completion), MRTR/cache/tasks, OpenTelemetry, and extensions.

## Installation

```sh
npm install @jangmanj/mcp-client
```

## Quickstart

Push first: subscribe to events and react as they arrive. Pull (tools, resources) is
there when you need it.

```ts
import { connect } from "@jangmanj/mcp-client/client";

const connection = await connect({
  stdio: { command: "npx", args: ["-y", "your-mcp-server"] },
  reconnectOnDrop: true,
});

try {
  // Events extension: live occurrences over events/stream (heartbeat + reconnect).
  const mail = await connection.events.subscribe("mail", { folder: "inbox" });
  for await (const event of mail) {
    console.log(event.eventId, event.data);
  }

  // Standard MCP subscriptions: tools/prompts/resources list_changed, resource updates.
  const changes = connection.listen({ tools: true });
  await changes.acknowledged;
  for await (const change of changes.events) {
    console.log(change.method); // e.g. notifications/tools/list_changed -> re-list tools
  }
} finally {
  await connection.close();
}
```

`connection.events` uses the optional `io.modelcontextprotocol/events` extension and
calls `server/discover` lazily to check support; `subscription.poll()` is available
when you explicitly want pull. `connection.listen()` is the spec-standard
`subscriptions/listen` stream.

Tools work the same connection, without `Outcome` matching:

```ts
const tools = await connection.tools.list();
const result = await connection.tools.call("list_allowed_directories");
console.log(result.content);
```

`tools.list()` / `tools.call()` return values or throw `McpOutcomeError`. For the full
protocol surface (MRTR, tasks, uncertain writes), use `connection.ops` directly and
match on `Outcome.kind`.

HTTP servers use `http:` instead of `stdio:`:

```ts
import { ConfiguredBearer } from "@jangmanj/mcp-client/auth";

const connection = await connect({
  http: {
    url: "https://mcp.example.com/mcp",
    authProvider: new ConfiguredBearer({
      resource: "https://mcp.example.com/mcp",
      token: process.env.MCP_TOKEN!,
    }),
  },
});
```

For interactive OAuth (discovery, PKCE, CIMD/DCR), construct `OAuthAuthorization` from
`/auth` with your consent/browser/redirect ports and pass it as `authProvider`.

## Errors, cancellation, progress

- **Simple mode** (`/client`): failures throw `McpOutcomeError`; inspect `error.outcome.kind`
  for `jsonrpc-error`, `transport-failure`, `tool-isError`, etc.
- **Full mode** (`/ops` + `/core`): every call returns a discriminated `Outcome` instead of
  throwing. `unwrapOutcome(outcome)` converts to throw-style.
- Pass `signal` (AbortSignal) and `timeoutMs` in request options to cancel or bound a call;
  pass `onProgress` to receive progress notifications. Cancellation is cooperative and
  sends `notifications/cancelled` when the request is already on the wire.
- `listAll()` follows cursors for you; single-page `list({ cursor })` is available when you
  need manual pagination. Cursors are opaque strings — never parse them.

## Testing your own tools

`@jangmanj/mcp-client/testing` provides an in-memory transport and a scriptable tool
server — no child processes or sockets:

```ts
import { connect } from "@jangmanj/mcp-client/client";
import { createToolServer } from "@jangmanj/mcp-client/testing";

const connection = await connect({
  transport: createToolServer({
    echo: { handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }) },
  }),
});
```

Throw `FakeJsonRpcError(code, message)` from a handler to simulate protocol errors.
`transport.push(notification, requestId?)` injects notifications into active request
streams, so you can test pushed events and `list_changed` without a live server.

## Low-level API

The quickstart above is a thin wrapper. The underlying pieces remain available when you
need them:

```ts
import { McpClient } from "@jangmanj/mcp-client";
import { createOps } from "@jangmanj/mcp-client/ops";
import { StdioTransport } from "@jangmanj/mcp-client/transport-stdio";

const client = new McpClient({
  transport: new StdioTransport({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }),
  server: { key: "filesystem" },
});
const ops = createOps(client);
// ... await ops.tools.listAll() / ops.tools.call(...), then await client.close()
```

## Compatibility expectations

- This library targets **MCP 2026-07-28** (stateless, per-request `_meta`). Older servers
  are detected and diagnosed via era probing; it is not a full 2025-style `initialize` client.
- Node **>= 22.19**, ESM-first (CJS `require(esm)` works on supported Node versions).
- Roots, sampling, and logging are deprecated upstream and intentionally not implemented.

## Subpath exports

- `@jangmanj/mcp-client` (re-exports `./core`)
- `@jangmanj/mcp-client/core`
- `@jangmanj/mcp-client/client` (high-level `connect()` API)
- `@jangmanj/mcp-client/testing` (in-memory transport / fake tool server)
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
default), and task-based tool calls.

OAuth works out of the box for HTTP servers without a static `Authorization` header: the
first 401 marks the server "needs sign-in" in `/mcp`, and `/mcp login <name>` runs the
authorization-code + PKCE flow with CIMD/DCR registration through the system browser.
Credentials persist in `$PI_CODING_AGENT_DIR/mcp-client-oauth.json` (issuer-keyed);
`/mcp logout <name>` deletes them. The full `oauth` config shape is supported:
`clientId`, `clientSecret`, `clientName`, `callbackPort`, `callbackUrl` (loopback HTTP),
`scope` (space-separated, merged with advertised scopes), and `authServerMetadataUrl`
(trusted as configured, skips PRM discovery).

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
