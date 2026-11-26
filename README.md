# @jangmanj/mcp

MCP 2026-07-28 client library: core protocol/lifecycle, stdio and HTTP transports, OAuth/client-credentials auth, ops (tools/prompts/resources/completion), MRTR/cache/tasks, OpenTelemetry, and extensions.

## Installation

```sh
npm install @jangmanj/mcp
```

## Quickstart

Push first: subscribe to events and react as they arrive. Pull (tools, resources) is
there when you need it.

```ts
import { connect } from "@jangmanj/mcp/client";

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
import { ConfiguredBearer } from "@jangmanj/mcp/auth";

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

### Authorization callbacks

`startLoopbackRedirect()` binds an ephemeral `127.0.0.1` port for desktop sign-in.
To receive the browser at a real address — a public hostname, or a port forwarded by
a proxy — use `startHostedRedirect()`. It validates the configured URI the same way
(the authorization server always gets your configured `redirect_uri`), checks the
callback's `Host` and path, matches each callback to its pending request by `state`,
and never resolves a callback nobody asked for:

```ts
import { OAuthAuthorization, startHostedRedirect } from "@jangmanj/mcp/auth";

const redirect = await startHostedRedirect({
  redirectUri: "https://hooks.example.com/oauth/mcp/callback",
  port: 8710,            // local bind port a proxy forwards to; omit for ephemeral
  trustProxy: true,      // accept the public host from X-Forwarded-Host
  // tls: { key, cert }, // terminate TLS in-process instead of at the proxy
});

const authProvider = new OAuthAuthorization({
  resource: "https://mcp.example.com/mcp",
  redirectUri: redirect.redirectUri,
  redirect,
  consent: { async request() { return { decision: "accept" }; } },
  browser: { open: (url) => openSystemBrowser(url, AbortSignal.timeout(300_000)) },
});
```

Each pending authorization resolves with the callback's query parameters; a lapsed
callback resolves to `error=timeout` instead of hanging, and `close()` cancels the rest.

### Standalone callback server

When the sign-in client lives in another process, run the bundled server instead of
hosting the listener inside your app. It owns no client, binds the callback, and prints
one JSON line per event on stdout:

```sh
mcp-callback --redirect-uri https://hooks.example.com/oauth/mcp/callback \
  --port 8710 --trust-proxy
# {"event":"listening","redirectUri":"https://hooks.example.com/oauth/mcp/callback","address":"http://127.0.0.1:8710/oauth/mcp/callback","pid":8123}
# {"event":"callback","at":"...","state":"<state>","params":{"code":"<code>","state":"<state>","iss":"..."}}
```

`--once` exits after the first callback (or after `--state <value>` matches), which is
what a script wants; `--tls-key`/`--tls-cert` terminate TLS in-process; `--host`,
`--allowed-host`, `--max-pending`, and `--timeout-ms` tune the rest. `SIGINT` closes it
with a final `{"event":"closed","callbacks":n}`. The same process is available in
code as `runRedirectServer` from `@jangmanj/mcp/callback`.

## Building a server

`@jangmanj/mcp/server` covers the ordinary MCP 2026-07-28 request
surface; `@jangmanj/mcp/server-events` covers push. Both are
transport-agnostic — your host owns JSON-RPC dispatch, error mapping, and
listeners.

```ts
import { McpServer } from "@jangmanj/mcp/server";
import { EventBus, EventsServer, SubscriptionsServer, TaskCenter } from "@jangmanj/mcp/server-events";

const bus = new EventBus();
const subscriptions = new SubscriptionsServer({ capabilities: { tools: { listChanged: true } } });
const server = new McpServer({
  serverInfo: { name: "roger-wilco", version: "0.1.0" },
  subscriptions,
  events: new EventsServer({ bus }),
  tasks: new TaskCenter({ bus }),
});

server.registerTool({
  name: "roger_send",
  inputSchema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
  handler: async ({ body }) => {
    const mail = bus.publish("roger.mail", { body });
    return { content: [{ type: "text", text: mail.eventId }] };
  },
});
server.registerResource({ uri: "file:///board", name: "board", handler: () => "..." });
server.registerPrompt({ name: "reply", handler: () => ({ messages: [] }) });

// Ordinary JSON-RPC requests (tools/list, tools/call, resources/read,
// prompts/get, completion/complete, server/discover, events/*, tasks/*):
const result = await server.handleRequest(msg); // throws ServerError(code) for the host to map

// Long-lived streams still use host channels:
// subscriptions.listen(channel, params) / server.events?.stream(channel, params)
```

Included: deterministic pagination with opaque cursors, required `resultType`
and cache hints, input/output schema validation (Ajv 2020-12), resource
templates, prompt arguments, completion capping, MRTR `input_required` and
HMAC-protected `requestState` helpers with single-use retry correlation,
task-handle results with TTL expiry, and skills publishing with verified
manifests. Deprecated Logging/Roots/Sampling are intentionally absent.

## Server transports

`@jangmanj/mcp/server-transport` hosts an `McpServer` over real stdio or
streamable HTTP, including SSE push channels, `notifications/cancelled`, and
resource-side bearer auth:

```ts
import { StdioServerHost, HttpServerHost, StaticBearerAuth, buildProtectedResourceMetadata } from "@jangmanj/mcp/server-transport";

// stdio: newline-delimited JSON-RPC on stdin/stdout
await new StdioServerHost({ server }).listen();

// HTTP: POST-only /mcp, header enforcement, SSE streams, optional bearer auth
const host = new HttpServerHost({ server, auth: new StaticBearerAuth(process.env.MCP_TOKEN!) });
host.createServer().listen(7477, "127.0.0.1");
```

The HTTP host validates `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, and
`Mcp-Param-*` against the request body, returns `-32020` on mismatch, enforces
Origin/Accept rules, and serves `/healthz`. `buildProtectedResourceMetadata()`
helps you publish RFC 9728 metadata for OAuth clients.

## Push on the server side

`@jangmanj/mcp/server-events` is the modular, transport-agnostic server
companion: event logs with cursors, live `events/stream`, standard
`subscriptions/listen`, notices, and optional async tasks. It contains no
tools/resources/prompts registry of its own — that lives in
`@jangmanj/mcp/server` — so you can adopt push without adopting a
framework.

```ts
import { EventBus, EventsServer, SubscriptionsServer, TaskCenter, Notices } from "@jangmanj/mcp/server-events";

const bus = new EventBus();
const events = new EventsServer({ bus });
const subscriptions = new SubscriptionsServer({ capabilities: { tools: { listChanged: true } } });
const tasks = new TaskCenter({ bus });
const notices = new Notices(bus);

// Ordinary requests return plain results for your host to send:
const page = events.poll({ name: "mail", arguments: {}, cursor: null });

// Long-lived requests use a host channel (notify/finish/onClose):
// events.stream(channel, { name: "mail", arguments: {}, cursor: null });
// subscriptions.listen(channel, { notifications: { toolsListChanged: true } });

// Application code publishes; subscribed clients receive push notices:
bus.publish("mail", { subject: "hello" });
subscriptions.notifyToolsChanged();
notices.info("ready");
const task = tasks.create({ pollIntervalMs: 1000 });
tasks.complete(task.taskId, { ok: true });
```

Scope: `events/list`, `events/poll`, `events/stream`, `subscriptions/listen`,
`notifications/*` fanout, and `tasks/get`/`tasks/cancel`/`tasks/update` state.
Webhook delivery is intentionally out of scope; deprecated MCP Logging is not
used — notices travel as ordinary events. Skills publishing lives in
`@jangmanj/mcp/server` (`registerSkill`): manifests with computed
SHA-256/size, `skills/list`/`skills/get`, and file bytes via `resources/read`.

For discovery metadata, `@jangmanj/mcp/ext-server-cards` also includes a
card builder for servers you operate:

```ts
import { buildServerCard, buildAiCatalog } from "@jangmanj/mcp/ext-server-cards";

const card = buildServerCard({
  name: "roger-wilco",
  version: "0.1.0",
  description: "Durable cross-machine mail with push/poll event streams.",
  remotes: [{ type: "streamable-http", url: "https://roger.example.net/mcp", supportedVersions: ["2026-07-28"] }],
});
const catalog = buildAiCatalog([card]); // serve as /.well-known/ai-catalog.json
```

Cards are advisory only: primitive capability fields are rejected, and live
`server/discover` remains authoritative.

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

`@jangmanj/mcp/testing` provides an in-memory transport and a scriptable tool
server — no child processes or sockets:

```ts
import { connect } from "@jangmanj/mcp/client";
import { createToolServer } from "@jangmanj/mcp/testing";

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
import { McpClient } from "@jangmanj/mcp";
import { createOps } from "@jangmanj/mcp/ops";
import { StdioTransport } from "@jangmanj/mcp/transport-stdio";

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

- `@jangmanj/mcp` (re-exports `./core`)
- `@jangmanj/mcp/core`
- `@jangmanj/mcp/client` (high-level `connect()` API)
- `@jangmanj/mcp/testing` (in-memory transport / fake tool server)
- `@jangmanj/mcp/server-events` (push-first server building blocks)
- `@jangmanj/mcp/server` (tools/resources/prompts/discover/completion server)
- `@jangmanj/mcp/server-transport` (stdio + streamable HTTP server hosts)
- `@jangmanj/mcp/auth`
- `@jangmanj/mcp/ops`
- `@jangmanj/mcp/mrtr-cache`
- `@jangmanj/mcp/telemetry-otel`
- `@jangmanj/mcp/transport-http`
- `@jangmanj/mcp/transport-stdio`
- `@jangmanj/mcp/ext-events`
- `@jangmanj/mcp/ext-server-cards`
- `@jangmanj/mcp/ext-skills`

## TypeScript

- Use `"moduleResolution": "NodeNext"` (or `"Bundler"`) in your consumer `tsconfig.json` so subpath exports resolve cleanly.
- If your consumer `tsconfig.json` overrides `"lib"` without `"DOM"` (for example `"lib": ["ES2023"]`), install `@types/node` and include `"types": ["node"]` so standard Web/Node globals (`AbortSignal`, `URL`, `Response`, `CryptoKey`) are typed.

## Pi extension

This package doubles as a [Pi](https://pi.dev) package: installing it registers an
extension that replaces Pi's built-in MCP session support with a bridge built on
this library (transports, lifecycle, ops, MRTR) and exposes each server's tools to
Pi as `mcp__<server>__<tool>`.

```sh
pi install npm:@jangmanj/mcp
# or from a checkout / git ref:
pi install ./path/to/mcp
pi install git:github.com/JangMan-J/mcp@v0.14.0
```

The extension reads the same `mcp.json` files as built-in MCP
(`$PI_CODING_AGENT_DIR/mcp.json` or `~/.pi/agent/mcp.json`, plus `.pi/mcp.json` in
trusted projects) with the same merge, interpolation (`${VAR}`, `${VAR:-fallback}`, `!command`),
`autoEnableCodemode`, `auth: { "provider": "<name>" }`, and exposure rules (`codemode` default —
registered as `deferred` on Pi so MCP tools do not bloat `codemode`'s prompt declaration — plus
`direct`/`deferred`/`hidden` and `toolExposure` patterns). `/mcp` lists server states; `/mcp reconnect <name>` restarts one.
Servers registered by other extensions via `pi.registerMcpServer()` are connected
too, with file configuration taking precedence.

Push events (`io.modelcontextprotocol/events`) wake idle Pi sessions or queue follow-ups automatically
via `pi.sendMessage(..., { triggerTurn: true })` when `"subscribe"` is set on a server entry
(`true`, or an allowlist of event names/patterns/specs such as `["roger.mail"]`, plus optional
`"eventDelivery": "followUp" | "steer" | "nextTurn"`). Inspect active event subscriptions with `/mcp events <name>`.

The extension lives in `adapters/pi/` (isolated from the protocol packages).
Beyond tools and push events, it covers built-in MCP parity: `list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource` (omitting `ui://` MCP App resources),
`CallToolResult` `outputSchema`/`structuredContent` for `codemode` scripts, dynamic `list_changed`
tool updates, `/mcp events|prompts|prompt|resources|task|enable|disable|exposure`
subcommands, MRTR elicitation through Pi's UI, task handles with `tasks/get`
and `tasks/cancel`, 20 KB middle-out text truncation with temp-file offload,
and a rotating `$PI_CODING_AGENT_DIR/mcp.log`.

OAuth works out of the box for HTTP servers without a static `Authorization` header: the
first 401 marks the server "needs sign-in" in `/mcp`, and `/mcp login <name>` runs the
authorization-code + PKCE flow with CIMD/DCR registration through the system browser.
Credentials persist in `$PI_CODING_AGENT_DIR/mcp-oauth.json` (issuer-keyed);
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
