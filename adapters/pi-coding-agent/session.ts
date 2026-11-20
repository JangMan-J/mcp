type SessionClient = { close(): Promise<void> | void };

/** The host supplies enabled server names and a factory bound to their configuration. */
export async function startSession<C extends SessionClient>(
  enabledServers: Iterable<string>,
  createClient: (server: string, signal: AbortSignal) => C | Promise<C>,
) {
  const controller = new AbortController();
  const clients = new Map<string, C>();
  let closing: Promise<void> | undefined;

  async function closeClients() {
    const results = await Promise.allSettled(Array.from(clients.values(), async client => client.close()));
    clients.clear();
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(f => f.reason), "Session close failed");
  }

  function shutdown() {
    closing ??= Promise.resolve().then(closeClients);
    controller.abort();
    return closing;
  }

  try {
    for (const name of enabledServers) {
      if (!clients.has(name)) clients.set(name, await createClient(name, controller.signal));
    }
  } catch (error) {
    try { await shutdown(); } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Session startup and cleanup failed");
    }
    throw error;
  }

  async function run<T>(name: string, operation: (client: C, signal: AbortSignal) => T | Promise<T>, request?: AbortSignal) {
    const signal = request ? AbortSignal.any([controller.signal, request]) : controller.signal;
    signal.throwIfAborted();
    const client = clients.get(name);
    if (!client) throw new Error(`No session client for server: ${name}`);
    try {
      return await operation(client, signal);
    } finally {
      // Even a transport that ignored cancellation cannot deliver a stale result.
      signal.throwIfAborted();
    }
  }

  return { signal: controller.signal, run, shutdown };
}
