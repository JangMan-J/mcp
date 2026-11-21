import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { createCoreFeatures } from './core-features.js';

function runtime(listen: ReturnType<typeof vi.fn>) {
  return {
    ready: async () => ({ kind: 'ok' as const, value: {} }), capabilities: { resources: { subscribe: true } },
    transportClosed: new AbortController().signal, stateful: { subscriptions: { listen } },
  };
}
const stream = (uris: readonly string[]) => ({
  state: 'active', events: (async function* () { await new Promise(() => {}); })(), close() {},
  acknowledged: Promise.resolve({ granted: { resourceSubscriptions: uris } }),
});

it('persists acknowledged resource URIs across reopen; unsubscribe persists, close does not erase', async () => {
  const db = new DatabaseSync(':memory:');
  const open = async (listen: ReturnType<typeof vi.fn>) => createCoreFeatures({ id: 'alpha', descriptor: { name: 'alpha' }, runtime: runtime(listen) as never, db, options: {} });
  const call = (f: Awaited<ReturnType<typeof open>>, action: string) => f.run('mcp_resources', { action, uri: 'file:///a' }, new AbortController().signal);
  const listen = vi.fn((f: { resourceUris?: readonly string[] }) => stream(f.resourceUris ?? []));

  const first = await open(listen);
  expect(first.names).toEqual(['mcp_resources']);
  await call(first, 'subscribe');
  await first.close();

  const reopenListen = vi.fn((f: { resourceUris?: readonly string[] }) => stream(f.resourceUris ?? []));
  const second = await open(reopenListen);
  await vi.waitFor(() => expect(reopenListen).toHaveBeenCalledWith(expect.objectContaining({ resourceUris: ['file:///a'] })));
  expect(await second.run('mcp_resources', { action: 'subscriptions' }, new AbortController().signal))
    .toMatchObject({ subscriptions: [{ uris: ['file:///a'] }] });
  await call(second, 'unsubscribe');
  await second.close();

  const third = vi.fn((f: { resourceUris?: readonly string[] }) => stream(f.resourceUris ?? []));
  await (await open(third)).close();
  expect(third).not.toHaveBeenCalledWith(expect.objectContaining({ resourceUris: expect.anything() }));
  db.close();
});
