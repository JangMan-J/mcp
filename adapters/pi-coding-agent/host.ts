// Narrow Pi host adapter: /mcp command + session lifecycle only.
// No protocol logic here: every operation delegates to McpServerPort.
// Nested tool-call pipeline is a separate adapter concern and is not
// registered by this module.

import type { AuthorizationConsent, RedirectPort } from "../../packages/auth/src/provider.ts";

/** Identifier of the built-in MCP extension this adapter replaces. */
export const BUILTIN_MCP = "builtin:mcp" as const;
export type BuiltinMcpId = typeof BUILTIN_MCP;

/** Auth ports the host may supply to the server port. Type-only re-exports
 *  from packages/auth so this adapter never needs a package build step. */
export type AuthConsentPort = AuthorizationConsent;
export type AuthRedirectPort = RedirectPort;

export interface Disposable {
  dispose(): void;
}

export type ServerStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "needs-auth"
  | "error";

export interface McpServerSummary {
  readonly id: string;
  readonly enabled: boolean;
  readonly status: ServerStatus;
  readonly detail?: string;
}

/**
 * Server operations used by /mcp. Implementations own protocol, auth
 * flows and connections; this module only dispatches and formats.
 */
export interface McpServerPort {
  list(): readonly McpServerSummary[] | Promise<readonly McpServerSummary[]>;
  status(id: string): McpServerSummary | undefined | Promise<McpServerSummary | undefined>;
  setEnabled(id: string, enabled: boolean): void | Promise<void>;
  signIn(id: string, signal: AbortSignal): Promise<void>;
  start(signal: AbortSignal): void | Promise<void>;
  shutdown(): void | Promise<void>;
}

export type McpCommandNotifyKind = "info" | "error";

export interface McpCommandContext {
  notify(message: string, kind?: McpCommandNotifyKind): void;
  readonly signal?: AbortSignal;
}

export interface McpCommandDefinition {
  readonly description: string;
  handler(args: string, ctx: McpCommandContext): Promise<void>;
}

export type PiSessionEvent = "session_start" | "session_shutdown";
export type PiSessionHandler = (ctx: McpCommandContext) => void | Promise<void>;

/** Minimal Pi extension-host surface this adapter depends on (fakeable). */
export interface PiHostPort {
  registerCommand(name: "mcp", definition: McpCommandDefinition): Disposable;
  on(event: PiSessionEvent, handler: PiSessionHandler): Disposable;
  /** Disable a built-in extension; the returned disposer restores it. */
  disableBuiltin(id: BuiltinMcpId): Disposable;
}

/** All ports supplied to installHost. Auth ports are passed through to
 *  server implementations; installHost itself does not consume them. */
export interface HostPorts {
  readonly host: PiHostPort;
  readonly servers: McpServerPort;
  readonly consent?: AuthConsentPort;
  readonly redirect?: AuthRedirectPort;
  readonly browser?: { open(url: string, signal: AbortSignal): Promise<void> };
}

export type McpSubcommand = "list" | "status" | "enable" | "disable" | "sign-in";

const formatServer = (s: McpServerSummary): string =>
  `${s.id}: ${s.enabled ? s.status : "disabled"}${s.detail ? ` (${s.detail})` : ""}`;

export function parseMcpArgs(args: string): { sub: McpSubcommand; id?: string } | undefined {
  const parts = args.trim().split(/\s+/u).filter(Boolean);
  const sub = (parts[0] ?? "list") as McpSubcommand;
  if (!["list", "status", "enable", "disable", "sign-in"].includes(sub)) return undefined;
  const id = parts[1];
  if ((sub === "enable" || sub === "disable" || sub === "sign-in") && !id) return undefined;
  return id === undefined ? { sub } : { sub, id };
}

/**
 * Register /mcp and the session lifecycle handlers, replacing builtin:mcp.
 * The returned disposer unregisters everything, shuts an active session
 * down, and restores builtin:mcp. It is idempotent.
 */
export function installHost(ports: HostPorts): Disposable {
  const { host, servers } = ports;
  let disposed = false;
  let session: AbortController | undefined;
  let sessionActive = false;

  const disposables: Disposable[] = [];
  // Replace the built-in first so /mcp ownership is unambiguous.
  disposables.push(host.disableBuiltin(BUILTIN_MCP));

  const sessionSignal = (ctx: McpCommandContext): AbortSignal =>
    ctx.signal ?? session?.signal ?? new AbortController().signal;

  const dispatch = async (args: string, ctx: McpCommandContext): Promise<void> => {
    const parsed = parseMcpArgs(args);
    if (!parsed) {
      ctx.notify("Usage: /mcp [list|status [server]|enable <server>|disable <server>|sign-in <server>]", "error");
      return;
    }
    switch (parsed.sub) {
      case "list": {
        const all = await servers.list();
        ctx.notify(all.length ? all.map(formatServer).join("\n") : "No MCP servers configured.");
        return;
      }
      case "status": {
        if (!parsed.id) {
          const all = await servers.list();
          ctx.notify(all.length ? all.map(formatServer).join("\n") : "No MCP servers configured.");
          return;
        }
        const one = await servers.status(parsed.id);
        ctx.notify(one ? formatServer(one) : `Unknown MCP server: ${parsed.id}`, one ? "info" : "error");
        return;
      }
      case "enable":
      case "disable": {
        const enabled = parsed.sub === "enable";
        await servers.setEnabled(parsed.id!, enabled);
        const one = await servers.status(parsed.id!);
        ctx.notify(one ? formatServer(one) : `${parsed.id}: ${enabled ? "enabled" : "disabled"}`);
        return;
      }
      case "sign-in": {
        await servers.signIn(parsed.id!, sessionSignal(ctx));
        ctx.notify(`${parsed.id}: sign-in complete`);
        return;
      }
    }
  };

  disposables.push(host.registerCommand("mcp", {
    description: "List MCP servers, show status, enable/disable, or sign in",
    handler: dispatch,
  }));

  disposables.push(host.on("session_start", async () => {
    session?.abort();
    session = new AbortController();
    sessionActive = true;
    await servers.start(session.signal);
  }));

  disposables.push(host.on("session_shutdown", async () => {
    session?.abort();
    session = undefined;
    if (sessionActive) {
      sessionActive = false;
      await servers.shutdown();
    }
  }));

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      session?.abort();
      session = undefined;
      // Unregister handlers/command first, then restore builtin:mcp last
      // (reverse of install) so /mcp is never owned by both at once.
      for (const d of [...disposables].reverse()) d.dispose();
      if (sessionActive) {
        sessionActive = false;
        // Session already aborted above; shutdown is best-effort here
        // because dispose() is synchronous.
        void Promise.resolve(servers.shutdown()).catch(() => undefined);
      }
    },
  };
}
