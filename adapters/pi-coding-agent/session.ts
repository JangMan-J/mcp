import type { BranchState } from "./branch.js";

export interface SessionClient {
  ready?(signal: AbortSignal): Promise<void> | void;
  close(): Promise<void> | void;
}

interface SessionOptions<C> {
  /** Decoded branch state; its presence defers connection until first use. */
  branch?: BranchState;
  reestablish?(server: string, client: C, branch: BranchState, signal: AbortSignal): Promise<void> | void;
}

interface Connection<C> {
  controller: AbortController;
  signal: AbortSignal;
  acquired?: Promise<C>;
  ready?: Promise<C>;
  client?: C;
}

/** The host supplies enabled server names and a factory bound to their configuration. */
export async function startSession<C extends SessionClient>(
  enabledServers: Iterable<string>,
  createClient: (server: string, signal: AbortSignal) => C | Promise<C>,
  { branch, reestablish }: SessionOptions<C> = {},
) {
  const controller = new AbortController();
  const servers = new Map<string, Connection<C>>();
  const retiring = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;

  function connect(name: string, entry: Connection<C>) {
    const { signal } = entry;
    entry.acquired ??= Promise.resolve().then(() => {
      signal.throwIfAborted();
      return createClient(name, signal);
    });
    return entry.ready ??= entry.acquired.then(async client => {
      signal.throwIfAborted();
      await client.ready?.(signal);
      signal.throwIfAborted();
      if (branch !== undefined) await reestablish?.(name, client, branch, signal);
      signal.throwIfAborted();
      return entry.client = client;
    });
  }

  async function enable(name: string) {
    controller.signal.throwIfAborted();
    let entry = servers.get(name);
    if (!entry) {
      const local = new AbortController();
      entry = { controller: local, signal: AbortSignal.any([controller.signal, local.signal]) };
      servers.set(name, entry);
    }
    if (branch === undefined) await connect(name, entry);
  }

  async function disable(name: string) {
    const entry = servers.get(name);
    if (!entry) return;
    servers.delete(name);
    // Close as soon as the factory hands over a client, even if readiness hangs.
    const cleanup = entry.acquired?.then(client => client.close(), () => undefined);
    if (cleanup) retiring.add(cleanup);
    entry.controller.abort();
    try { await cleanup; } finally { if (cleanup) retiring.delete(cleanup); }
  }

  function shutdown() {
    closing ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([...retiring, ...Array.from(servers.keys(), disable)]);
      const failures = results.filter(result => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(f => f.reason), "Session close failed");
    });
    controller.abort();
    return closing;
  }

  try {
    for (const name of enabledServers) await enable(name);
  } catch (error) {
    try { await shutdown(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Session startup and cleanup failed");
    }
    throw error;
  }

  async function run<T>(name: string, operation: (client: C, signal: AbortSignal) => T | Promise<T>, request?: AbortSignal) {
    const entry = servers.get(name);
    const lifetime = entry?.signal ?? controller.signal;
    const signal = request ? AbortSignal.any([lifetime, request]) : lifetime;
    signal.throwIfAborted();
    if (!entry) throw new Error(`No session client for server: ${name}`);
    try {
      const client = entry.client ?? await connect(name, entry);
      signal.throwIfAborted();
      return await operation(client, signal);
    } finally {
      // Even a transport that ignored cancellation cannot deliver a stale result.
      signal.throwIfAborted();
    }
  }

  return { signal: controller.signal, run, enable, disable, shutdown };
}
