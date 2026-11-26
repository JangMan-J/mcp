#!/usr/bin/env node
/**
 * Standalone authorization callback server.
 *
 * Owns no client and imports no host: it binds the redirect listener, reports the URI to hand to
 * the authorization server, and relays each callback as one JSON line on stdout so any process can
 * consume it. Ctrl+C (or --once) ends it.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { type HostedRedirectOptions, startHostedRedirect } from '@mcp/auth';

export interface RedirectServerArgs extends HostedRedirectOptions {
  readonly once: boolean;
  readonly expectedState?: string;
}

export interface RedirectServerIo {
  stdout(line: string): void;
  stderr(line: string): void;
  /** Stops the server the way Ctrl+C does; lets an embedder or a test end it deterministically. */
  signal?: AbortSignal;
}

/** setTimeout clamps anything above this to 1 ms, so "no deadline" must stay representable. */
const MAX_TIMER_MS = 2_147_483_647;

const USAGE = `Usage: mcp-callback --redirect-uri <url> [options]

Binds an OAuth authorization callback and prints one JSON line per event.

Required
  --redirect-uri <url>     Absolute https callback URI the authorization server will use
                           (or loopback http with --allow-insecure-dev)

Binding
  --host <addr>            Address to bind (default 127.0.0.1)
  --port <port>            Port to bind; 0 picks an ephemeral port (default 0)
  --allowed-host <host>    Extra Host header value to accept (repeatable)
  --trust-proxy            Accept the callback host from X-Forwarded-Host
  --tls-key <path>         Serve TLS in-process with this PEM key
  --tls-cert <path>        Serve TLS in-process with this PEM certificate

Behaviour
  --once                   Exit after the first relayed callback
  --timeout-ms <ms>        Per-authorization deadline (default 300000; 0 disables)
  --max-pending <n>        Registerable authorizations at once (default 8)
  --state <value>          Reject callbacks whose state differs
  --allow-insecure-dev     Permit a loopback http redirect URI
  -h, --help               Show this help

Output (stdout, one JSON object per line)
  {"event":"listening","redirectUri":..,"address":..,"pid":..}
  {"event":"callback","at":..,"state":..,"params":{..}}
  {"event":"rejected","at":..,"reason":..}      (state mismatch or parse failure)
  {"event":"closed","at":..,"callbacks":n}
Exit codes: 0 ended, 1 server error, 2 bad usage.`;

class UsageError extends Error {}

function next(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
  return value;
}

function positiveInt(raw: string, flag: string, min: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new UsageError(`${flag} must be an integer >= ${min}`);
  return value;
}

export function parseRedirectServerArgs(argv: readonly string[]): RedirectServerArgs | 'help' {
  let redirectUri: string | undefined;
  let host: string | undefined;
  let port: number | undefined;
  let timeoutMs: number | undefined;
  let maxPending: number | undefined;
  let expectedState: string | undefined;
  let tlsKey: string | undefined;
  let tlsCert: string | undefined;
  let allowInsecureDev = false;
  let trustProxy = false;
  let once = false;
  const allowedHosts: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    switch (flag) {
      case '-h': case '--help': return 'help';
      case '--redirect-uri': redirectUri = next(argv, index, flag); index++; break;
      case '--host': host = next(argv, index, flag); index++; break;
      case '--port': port = positiveInt(next(argv, index, flag), flag, 0); index++; break;
      case '--allowed-host': allowedHosts.push(next(argv, index, flag)); index++; break;
      case '--tls-key': tlsKey = next(argv, index, flag); index++; break;
      case '--tls-cert': tlsCert = next(argv, index, flag); index++; break;
      case '--timeout-ms': timeoutMs = positiveInt(next(argv, index, flag), flag, 0); index++; break;
      case '--max-pending': maxPending = positiveInt(next(argv, index, flag), flag, 1); index++; break;
      case '--state': expectedState = next(argv, index, flag); index++; break;
      case '--allow-insecure-dev': allowInsecureDev = true; break;
      case '--trust-proxy': trustProxy = true; break;
      case '--once': once = true; break;
      default: throw new UsageError(`unknown option ${flag}`);
    }
  }

  if (redirectUri === undefined) throw new UsageError('--redirect-uri is required');
  if ((tlsKey === undefined) !== (tlsCert === undefined)) throw new UsageError('--tls-key and --tls-cert go together');
  return {
    redirectUri,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(allowedHosts.length === 0 ? {} : { allowedHosts }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs === 0 ? MAX_TIMER_MS : timeoutMs }),
    ...(maxPending === undefined ? {} : { maxPending }),
    ...(trustProxy ? { trustProxy } : {}),
    ...(allowInsecureDev ? { allowInsecureDev } : {}),
    ...(expectedState === undefined ? {} : { expectedState }),
    once,
    ...(tlsKey === undefined || tlsCert === undefined ? {} : { tls: { key: tlsKey, cert: tlsCert } }),
  };
}

/** Runs the server until it is closed or `--once` is satisfied; resolves to the process exit code. */
export async function runRedirectServer(argv: readonly string[], io: RedirectServerIo): Promise<number> {
  let args: RedirectServerArgs | 'help';
  try {
    args = parseRedirectServerArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`mcp-callback: ${error.message}`);
    io.stderr(USAGE);
    return 2;
  }
  if (args === 'help') {
    io.stdout(USAGE);
    return 0;
  }

  const { once, expectedState, tls, ...options } = args;
  let callbacks = 0;
  let close!: () => void;
  const ended = new Promise<void>(resolve => { close = resolve; });
  const emit = (value: Record<string, unknown>): void => io.stdout(JSON.stringify(value));

  let tlsFiles: { key: string; cert: string } | undefined;
  if (tls !== undefined) {
    try {
      tlsFiles = { key: readFileSync(String(tls.key), 'utf8'), cert: readFileSync(String(tls.cert), 'utf8') };
    } catch (error) {
      io.stderr(`mcp-callback: cannot read TLS material: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  const redirect = await startHostedRedirect({
    ...options,
    ...(tlsFiles === undefined ? {} : { tls: tlsFiles }),
    onCallback: params => {
      const state = params.get('state');
      if (expectedState !== undefined && state !== expectedState) {
        emit({ event: 'rejected', at: new Date().toISOString(), reason: 'state-mismatch' });
        return;
      }
      callbacks++;
      emit({ event: 'callback', at: new Date().toISOString(), state, params: Object.fromEntries(params) });
      if (once) finish();
    },
  });

  const stop = (): void => finish();
  const finish = (): void => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    io.signal?.removeEventListener('abort', stop);
    redirect.close();
    emit({ event: 'closed', at: new Date().toISOString(), callbacks });
    close();
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  io.signal?.addEventListener('abort', stop, { once: true });
  emit({
    event: 'listening',
    redirectUri: redirect.redirectUri,
    address: redirect.listening,
    pid: process.pid,
  });

  await ended;
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // A closed stdout means the consumer went away; stop instead of throwing EPIPE.
  process.stdout.on('error', () => process.exit(0));
  // No top-level await: the module stays require()-able as well as importable.
  void runRedirectServer(process.argv.slice(2), {
    stdout: line => { process.stdout.write(`${line}\n`); },
    stderr: line => { process.stderr.write(`${line}\n`); },
  }).then(code => { process.exitCode = code; }, () => { process.exitCode = 1; });
}
