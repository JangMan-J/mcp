// Narrow Pi host adapter: /mcp command + session lifecycle only.
// No protocol logic here: every operation delegates to McpServerPort.
// Nested tool-call pipeline is a separate adapter concern and is not
// registered by this module.

import type { AuthorizationConsent, RedirectPort } from "@mcp-client/auth";
import type { BrowserPort, Disposable } from "@mcp-client/core";

export type { Disposable } from "@mcp-client/core";

/** Identifier of the built-in MCP extension this adapter replaces. */
export const BUILTIN_MCP = "builtin:mcp" as const;
export type BuiltinMcpId = typeof BUILTIN_MCP;

/** Auth ports the host may supply to the server port, re-exported under
 *  adapter-local names from the built public @mcp-client/auth surface. */
export type AuthConsentPort = AuthorizationConsent;
export type AuthRedirectPort = RedirectPort;

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
  reconnect?(id: string, signal: AbortSignal): Promise<void>;
  card?(id: string, signal: AbortSignal): Promise<unknown>;
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
  readonly browser?: BrowserPort;
}

const mcpCommands = ["list", "status", "enable", "disable", "sign-in", "reconnect", "card"] as const;
export type McpSubcommand = typeof mcpCommands[number];

const formatServer = (s: McpServerSummary): string =>
  `${s.id}: ${s.enabled ? s.status : "disabled"}${s.detail ? ` (${s.detail})` : ""}`;

export function parseMcpArgs(args: string): { sub: McpSubcommand; id?: string } | undefined {
  const parts = args.trim().split(/\s+/u).filter(Boolean);
  const sub = (parts[0] ?? "list") as McpSubcommand;
  if (!mcpCommands.includes(sub)) return undefined;
  const id = parts[1];
  if (sub !== "list" && sub !== "status" && !id) return undefined;
  return id === undefined ? { sub } : { sub, id };
}

/**
 * Register /mcp and the session lifecycle handlers, replacing builtin:mcp.
 * The returned disposer unregisters everything, shuts an active session
 * down, and restores builtin:mcp. It is idempotent.
 */
interface SessionState {
  readonly controller: AbortController;
  /** servers.start has been invoked (and may still be in flight). */
  started: boolean;
  shutdownRequested: boolean;
  shutdownCalled: boolean;
}

export function installHost(ports: HostPorts): Disposable {
  const { host, servers } = ports;
  let disposed = false;
  let current: SessionState | undefined;

  const disposables: Disposable[] = [];
  // Replace the built-in first so /mcp ownership is unambiguous.
  disposables.push(host.disableBuiltin(BUILTIN_MCP));

  // Lifecycle operations (servers.start / servers.shutdown) are serialized
  // through this tail so overlapping session_start/session_shutdown/dispose
  // can never run them concurrently or shut down before an in-flight start
  // has settled (which would leave a started session nobody shuts down).
  let tail: Promise<void> | undefined;
  const enqueue = (op: () => Promise<void>): Promise<void> => {
    const run = tail ? tail.then(op) : op();
    const settled = run.then(
      () => { if (tail === settled) tail = undefined; },
      () => { if (tail === settled) tail = undefined; },
    );
    tail = settled;
    return run;
  };

  const newSession = (): SessionState => ({
    controller: new AbortController(),
    started: false,
    shutdownRequested: false,
    shutdownCalled: false,
  });

  // Queued behind any in-flight start, so shutdown only ever runs after
  // that start settled; a session aborted before its start ran is skipped.
  const shutdownSession = (state: SessionState): Promise<void> =>
    enqueue(async () => {
      if (!state.started || state.shutdownCalled) return;
      state.shutdownCalled = true;
      await servers.shutdown();
    });

  // Sign-in is bound to the session signal (combined with any per-command
  // signal) so session_shutdown/dispose always abort it, even when the
  // command context carries its own signal. A controller is retained even
  // before session_start so a later shutdown can still abort the sign-in.
  const sessionSignal = (ctx: McpCommandContext): AbortSignal => {
    current ??= newSession();
    return ctx.signal
      ? AbortSignal.any([ctx.signal, current.controller.signal])
      : current.controller.signal;
  };

  const dispatch = async (args: string, ctx: McpCommandContext): Promise<void> => {
    const parsed = parseMcpArgs(args);
    if (!parsed) {
      ctx.notify("Usage: /mcp [list|status [server]|enable <server>|disable <server>|sign-in <server>|reconnect <server>|card <server>]", "error");
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
      case "reconnect": {
        if (!servers.reconnect) { ctx.notify("MCP reconnect is unavailable", "error"); return; }
        await servers.reconnect(parsed.id!, sessionSignal(ctx));
        const one = await servers.status(parsed.id!);
        ctx.notify(one ? formatServer(one) : `${parsed.id}: reconnected`);
        return;
      }
      case "card": {
        if (!servers.card) { ctx.notify("MCP server cards are unavailable", "error"); return; }
        const signal = sessionSignal(ctx);
        signal.throwIfAborted();
        const card = await servers.card(parsed.id!, signal);
        signal.throwIfAborted();
        ctx.notify(typeof card === "string" ? card : JSON.stringify(card, null, 2) ?? "No MCP server card.");
        return;
      }
    }
  };

  disposables.push(host.registerCommand("mcp", {
    description: "Inspect, enable, disable, sign in, or reconnect MCP servers",
    handler: dispatch,
  }));

  disposables.push(host.on("session_start", async () => {
    if (disposed) return;
    current?.controller.abort();
    const state = newSession();
    current = state;
    await enqueue(async () => {
      // Superseded/aborted before this start got its turn: never start it;
      // the queued shutdown for it then has nothing to shut down.
      if (state.shutdownRequested || state.controller.signal.aborted) return;
      state.started = true;
      await servers.start(state.controller.signal);
    });
  }));

  disposables.push(host.on("session_shutdown", async () => {
    const state = current;
    if (!state) return;
    current = undefined;
    // Abort synchronously (kills any in-flight sign-in/start) but run the
    // shutdown itself through the lifecycle queue, exactly once.
    state.controller.abort();
    state.shutdownRequested = true;
    await shutdownSession(state);
  }));

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const state = current;
      current = undefined;
      state?.controller.abort();
      if (state) state.shutdownRequested = true;
      // Unregister handlers/command first, then restore builtin:mcp last
      // (reverse of install) so /mcp is never owned by both at once.
      for (const d of [...disposables].reverse()) d.dispose();
      if (state?.started) {
        // Runs immediately when no start is in flight; otherwise queued
        // behind it. Best-effort because dispose() is synchronous.
        void shutdownSession(state).catch(() => undefined);
      }
    },
  };
}
