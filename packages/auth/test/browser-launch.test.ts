import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import { openSystemBrowser } from '../src/index.js';

// Observe process creation without opening a desktop application.
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
beforeEach(() => spawn.mockReset());

it('passes the HTTPS URL as one opaque argument to a fixed launcher without a shell', async () => {
  const child = new EventEmitter();
  const unref = vi.fn();
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('spawn'));
    return Object.assign(child, { unref });
  });

  const url = 'https://as.invalid/authorize?state=one&scope=read;write';
  const expected = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] :
    [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  await openSystemBrowser(url, new AbortController().signal);
  expect(spawn.mock.calls).toEqual([[...expected, { shell: false, stdio: 'ignore', detached: true }]]);
  expect(unref).toHaveBeenCalledOnce();
});

it('does not spawn for a rejected URL or an already-cancelled launch', async () => {
  const signal = new AbortController().signal;
  await expect(openSystemBrowser('file:///example', signal)).rejects.toThrow('invalid-url');
  await expect(openSystemBrowser('https://as.invalid/`unsafe`', signal)).rejects.toThrow('invalid-url');
  await expect(openSystemBrowser('https://as.invalid/authorize', AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  expect(spawn).not.toHaveBeenCalled();
});
