import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
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
