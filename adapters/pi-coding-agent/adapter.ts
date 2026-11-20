import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLegacyConfig, type LegacyServerConfig, type LegacySource } from "./config.js";
import { createCredentialStore } from "./credentials.js";
import { installHost, type Disposable, type HostPorts, type McpServerPort,
  type McpServerSummary, type PiHostPort, type ServerStatus } from "./host.js";
import { startSession } from "./session.js";

type Client = { close(): void | Promise<void> };
type AuthPorts = Pick<HostPorts, "browser" | "consent" | "redirect">;

export interface ClientContext {
  readonly descriptor: LegacyServerConfig;
  readonly signal: AbortSignal;
  readonly trust: boolean;
  readonly credentialStore: ReturnType<typeof createCredentialStore>;
}

export interface CodingAgentAdapterOptions<C extends Client> extends AuthPorts {
  /** Trusted global directory: reads mcp.json and stores adapter credentials separately. */
  readonly configDir: string;
  /** Ignored (not read) unless the host has explicitly trusted the project. */
  readonly project?: { readonly configPath: string; readonly trusted: boolean };
  readonly createClient: (context: ClientContext) => C | Promise<C>;
  readonly signIn?: (context: ClientContext & AuthPorts & { readonly client: C }) => void | Promise<void>;
}

type Connection<C extends Client> = Awaited<ReturnType<typeof startSession<C>>>;
interface Active<C extends Client> {
  readonly abort: AbortController;
  readonly ready: Promise<Connection<C>>;
}
interface Server<C extends Client> {
  readonly descriptor: LegacyServerConfig;
  enabled: boolean;
  status: ServerStatus;
  active?: Active<C>;
  closing?: Promise<void>;
}

function readConfig(path: string, source: LegacySource): LegacyServerConfig[] {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return readLegacyConfig(JSON.parse(text), { source, trusted: true });
}

/** Compose the command and session ports without importing Pi or registering tools. */
export function installCodingAgentAdapter<C extends Client>(
  host: PiHostPort,
  options: CodingAgentAdapterOptions<C>,
): Disposable {
  const { configDir, project, createClient, signIn, browser, consent, redirect } = options;
  // Read before taking over /mcp, so an invalid config does not hide the built-in.
  const descriptors = readConfig(resolve(configDir, "mcp.json"), "global");
  if (project?.trusted === true) descriptors.push(...readConfig(project.configPath, "project"));
  const credentialStore = createCredentialStore(configDir);
  const servers = new Map<string, Server<C>>();
  // Trusted project entries override same-named global entries.
  for (const descriptor of descriptors) {
    servers.set(descriptor.name, { descriptor, enabled: descriptor.enabled, status: "disconnected" });
  }
  let sessionSignal: AbortSignal | undefined;

  const context = (descriptor: LegacyServerConfig, signal: AbortSignal): ClientContext =>
    ({ descriptor, signal, trust: descriptor.trusted, credentialStore });
  const summary = (server: Server<C>): McpServerSummary =>
    ({ id: server.descriptor.name, enabled: server.enabled, status: server.status });
  function requireServer(id: string): Server<C> {
    const server = servers.get(id);
    if (!server) throw new Error(`Unknown MCP server: ${id}`);
    return server;
  }

  async function connect(server: Server<C>, hostSignal: AbortSignal): Promise<void> {
    if (server.active) {
      await server.active.ready.catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, hostSignal]);
    const { descriptor, closing } = server;
    server.status = "connecting";
    // Give each server a session handle so toggles never recycle other clients.
    const ready = Promise.resolve().then(async () => {
      await closing;
      signal.throwIfAborted();
      return startSession([descriptor.name], (_id, internalSignal) => {
        const combined = AbortSignal.any([signal, internalSignal]);
        combined.throwIfAborted();
        return createClient(context(descriptor, combined));
      });
    });
    const active = { abort, ready };
    server.active = active;
    try {
      await ready;
      if (server.active === active && !signal.aborted) server.status = "connected";
    } catch {
      if (server.active === active) {
        delete server.active;
        server.status = signal.aborted ? "disconnected" : "error";
      }
    }
  }

  function disconnect(server: Server<C>): Promise<void> | undefined {
    const active = server.active;
    server.status = "disconnected";
    if (!active) return server.closing;
    delete server.active;
    active.abort.abort();
    const closing = active.ready.then(handle => handle.shutdown(), () => undefined).finally(() => {
      if (server.closing === closing) delete server.closing;
    });
    return server.closing = closing;
  }

  async function shutdown() {
    sessionSignal = undefined;
    const results = await Promise.allSettled(Array.from(servers.values(), disconnect));
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Adapter session close failed");
  }

  const port: McpServerPort = {
    list: () => Array.from(servers.values(), summary),
    status(id) {
      const server = servers.get(id);
      return server && summary(server);
    },
    async setEnabled(id, enabled) {
      const server = requireServer(id);
      server.enabled = enabled;
      if (!enabled) await disconnect(server);
      else if (sessionSignal && !sessionSignal.aborted) await connect(server, sessionSignal);
    },
    async signIn(id, request) {
      const server = requireServer(id);
      if (!signIn) throw new Error("MCP sign-in is unavailable");
      const { active } = server;
      if (!active || !sessionSignal) throw new Error(`No session client for server: ${id}`);
      const signal = AbortSignal.any([request, active.abort.signal, sessionSignal]);
      signal.throwIfAborted();
      const handle = await active.ready;
      await handle.run(id, (client, operationSignal) => signIn({
        ...context(server.descriptor, operationSignal), client,
        ...(browser && { browser }), ...(consent && { consent }), ...(redirect && { redirect }),
      }), signal);
    },
    async start(signal) {
      if (sessionSignal) await shutdown();
      if (signal.aborted) return;
      sessionSignal = signal;
      await Promise.all(Array.from(servers.values(), server => server.enabled ? connect(server, signal) : undefined));
    },
    shutdown,
  };
  return installHost({ host, servers: port });
}
