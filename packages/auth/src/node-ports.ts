import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { AuthError, cancelled, fail, secureUrl, withAbort } from './protocol.js';
import type { RedirectPort } from './provider.js';

/** Launch a fixed program with an opaque URL argument; never use a shell. */
export async function openSystemBrowser(input: string, signal: AbortSignal): Promise<void> {
  const url = secureUrl(input);
  signal.throwIfAborted();
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', detached: true });
    child.once('error', () => reject(new AuthError('auth-unavailable', 'browser')));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** Bind before registration so the host can register the exact callback URI. Single use. */
export async function startLoopbackRedirect(path = '/callback'): Promise<RedirectPort & {
  readonly redirectUri: string;
  close(): void;
}> {
  if (!/^\/[a-z0-9/_-]+$/iu.test(path)) fail('invalid-redirect-uri');
  let pending: { resolve: (value: URLSearchParams) => void; reject: (error: Error) => void } | undefined;
  let used = false;
  let redirectUri: string;
  const server = createServer((request, response) => {
    const target = request.url ?? '';
    if (request.method !== 'GET' || !target.startsWith(`${path}?`) || !pending || request.headers.host !== new URL(redirectUri).host) {
      response.writeHead(404, { Connection: 'close' }).end();
      return;
    }
    const resolve = pending.resolve;
    pending = undefined;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer', Connection: 'close' }).end('Authorization response received. You can close this tab.');
    resolve(new URLSearchParams(target.slice(path.length + 1)));
    server.close();
  });
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    const error = () => reject(new AuthError('auth-unavailable', 'redirect'));
    server.once('error', error);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', error); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); return fail('redirect-unavailable'); }
  redirectUri = `http://127.0.0.1:${address.port}${path}`;
  const close = () => {
    used = true;
    pending?.reject(new AuthError('auth-failure', 'cancelled'));
    pending = undefined;
    server.close();
    server.closeAllConnections();
  };
  return { redirectUri, close, async waitForCallback(options) {
    if (options.redirectUri !== redirectUri || used) fail('invalid-redirect-uri');
    used = true;
    const work = new Promise<URLSearchParams>((resolve, reject) => { pending = { resolve, reject }; });
    try { return await withAbort(work, options.signal, cancelled); } finally { close(); }
  } };
}

export interface HostedRedirectOptions {
  /** Absolute http(s) URI the authorization server sends the browser back to. */
  readonly redirectUri: string;
  /** Address to bind; defaults to 127.0.0.1 (keep it when a proxy terminates TLS). */
  readonly host?: string;
  /** Port to bind; 0 (the default) picks an ephemeral port. */
  readonly port?: number;
  /** Extra Host header values to accept, such as a proxy hop; the redirectUri host is always accepted. */
  readonly allowedHosts?: readonly string[];
  /** Accept the callback host from X-Forwarded-Host. Only behind a proxy you control. */
  readonly trustProxy?: boolean;
  /** Terminate TLS in-process instead of at a proxy. */
  readonly tls?: { readonly key: string | Buffer; readonly cert: string | Buffer };
  /** Authorizations allowed to await a callback at once; default 8. */
  readonly maxPending?: number;
  /** Deadline per authorization; default 300000 ms. */
  readonly timeoutMs?: number;
  /**
   * Relay every valid callback to this handler instead of requiring a waiter registered for its
   * `state`. A registered waiter still wins. Use it for a standalone callback server that does not
   * own the authorization request.
   */
  readonly onCallback?: (params: URLSearchParams) => void;
  readonly allowInsecureDev?: boolean;
}

export interface HostedRedirect extends RedirectPort {
  readonly redirectUri: string;
  /** Bound address for diagnostics; never carries credentials. */
  readonly listening: string;
  close(): void;
}

const REDIRECT_QUERY_KEYS = ['code', 'error', 'iss', 'state'];
const accept = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Connection: 'close' } as const;

/**
 * Hosted authorization callback: binds a real listener so the redirect URI can be a public address
 * instead of a loopback port. Unlike `startLoopbackRedirect` it serves many authorizations, matching
 * each callback to its pending request by `state`, and never resolves a callback the client did not ask for.
 */
export async function startHostedRedirect(options: HostedRedirectOptions): Promise<HostedRedirect> {
  const redirect = secureUrl(options.redirectUri, options.allowInsecureDev ?? false);
  if (redirect.hash || [...redirect.searchParams.keys()].some(key => REDIRECT_QUERY_KEYS.includes(key))) fail('invalid-redirect-uri');
  const maxPending = options.maxPending ?? 8;
  const timeoutMs = options.timeoutMs ?? 300_000;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) fail('invalid-max-pending');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) fail('invalid-timeout');
  const hosts = new Set([redirect.host, ...(options.allowedHosts ?? [])].map(host => host.toLowerCase()));

  const pending = new Map<string, { resolve: (value: URLSearchParams) => void; reject: (error: Error) => void }>();
  let closed = false;

  const settle = (state: string, params: URLSearchParams): void => {
    const waiter = pending.get(state);
    if (!waiter) return;
    pending.delete(state);
    waiter.resolve(params);
  };
  const rejectAll = (error: Error): void => {
    for (const waiter of [...pending.values()]) waiter.reject(error);
    pending.clear();
  };

  const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void => {
    const deniable = (status: number): void => { response.writeHead(status, accept).end(); };
    try {
      const target = request.url ?? '';
      const query = target.indexOf('?');
      const pathname = query === -1 ? target : target.slice(0, query);
      const forwarded = options.trustProxy === true ? request.headers['x-forwarded-host'] : undefined;
      const host = String(Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.headers.host ?? '').toLowerCase();
      if (request.method !== 'GET' || pathname !== redirect.pathname || !hosts.has(host)) { deniable(404); return; }
      const params = new URLSearchParams(query === -1 ? '' : target.slice(query + 1));
      const state = params.get('state');
      const claimed = state !== null && pending.has(state);
      if (!claimed && options.onCallback === undefined) { deniable(400); return; }
      response.writeHead(200, { ...accept, 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Authorization response received. You can close this tab.');
      if (claimed) settle(state, params);
      else options.onCallback?.(params);
    } catch { deniable(400); }
  };

  const server: Server = options.tls ? createTlsServer(options.tls, handler) : createServer(handler);
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    const error = () => reject(new AuthError('auth-unavailable', 'redirect'));
    server.once('error', error);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.removeListener('error', error); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); return fail('redirect-unavailable'); }
  const bound = `http${options.tls ? 's' : ''}://${options.host ?? '127.0.0.1'}:${address.port}${redirect.pathname}`;

  const close = (): void => {
    if (closed) return;
    closed = true;
    rejectAll(new AuthError('auth-failure', 'cancelled'));
    server.close();
    server.closeAllConnections();
  };

  return { redirectUri: redirect.href, listening: bound, close, async waitForCallback(request) {
    if (closed || request.redirectUri !== redirect.href) fail('invalid-redirect-uri');
    if (pending.has(request.state)) fail('duplicate-state');
    if (pending.size >= maxPending) fail('redirect-busy');
    const work = new Promise<URLSearchParams>((resolve, reject) => {
      const timer = setTimeout(() => settle(request.state, new URLSearchParams({ error: 'timeout' })), timeoutMs);
      timer.unref?.();
      pending.set(request.state, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
    try {
      return await withAbort(work, request.signal, cancelled);
    } finally {
      pending.delete(request.state);
    }
  } };
}
