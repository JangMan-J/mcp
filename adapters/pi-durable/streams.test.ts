import { DatabaseSync } from 'node:sqlite';
import { createEventsExtension, EVENTS_EXTENSION_ID, type Occurrence } from '@mcp-client/ext-events';
import { expect, it, vi } from 'vitest';
import { createStreamFeatures, globToRegExp } from './stream-features.js';
import { createCoreFeatures } from './core-features.js';
import type { ServerDescriptor } from './runtime.js';

const occurrence: Occurrence = {
  eventId: 'event-1', name: 'task.done', timestamp: new Date().toISOString(), data: { ok: true }, cursor: 'cursor-1',
};
function eventRuntime(poll = vi.fn(async () => ({ kind: 'ok' as const, value: { events: [occurrence], cursor: 'cursor-1' } }))) {
  const request = vi.fn(async (method: string) => method === 'events/list'
    ? { kind: 'ok' as const, value: { events: [{ name: 'task.done' }, { name: 'other' }] } }
    : poll());
  return {
    ready: async () => ({ kind: 'ok' as const, value: {} }),
    capabilities: { extensions: { [EVENTS_EXTENSION_ID]: {} } },
    eventsExtension: createEventsExtension({ enabled: true }),
    transportClosed: new AbortController().signal,
    client: { request },
  };
}
function context(db: DatabaseSync, runtime: ReturnType<typeof eventRuntime>, subscribe?: ServerDescriptor['subscribe']) {
  const wake = vi.fn();
  const deliver = vi.fn();
  return {
    wake, deliver,
    ctx: {
      id: 'alpha', descriptor: { name: 'alpha', ...(subscribe !== undefined ? { subscribe } : {}) },
      runtime: runtime as never, db, options: { wake, deliver },
    },
  };
}

it('matches globs and restores durable subscriptions without replaying committed events', async () => {
  const db = new DatabaseSync(':memory:');
  const rt = eventRuntime();
  const first = context(db, rt, [{ name: 'task.*' }]);
  const features = await createStreamFeatures(first.ctx);
  await vi.waitFor(() => expect(first.deliver).toHaveBeenCalledWith(occurrence));
  expect(first.wake).toHaveBeenCalledWith('alpha', 'event task.done');
  expect(await features.run('mcp_events', { action: 'subscriptions', server: 'alpha' }, new AbortController().signal))
    .toEqual({ subscriptions: [{ name: 'task.done', arguments: {}, cursor: 'cursor-1' }] });
  expect(await features.run('mcp_events', { action: 'poll' }, new AbortController().signal)).toEqual({ events: [occurrence] });
  await features.close();

  const reopened = context(db, rt);
  const restored = await createStreamFeatures(reopened.ctx);
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(reopened.deliver).not.toHaveBeenCalled();
  expect(await restored.run('mcp_events', { action: 'poll' }, new AbortController().signal)).toEqual({ events: [] });
  await restored.close(); db.close();
});

it('expands manual subscription globs and removes persisted subscriptions', async () => {
  const db = new DatabaseSync(':memory:');
  const made = context(db, eventRuntime());
  const features = await createStreamFeatures(made.ctx);
  expect(await features.run('mcp_events', { action: 'subscribe', name: 'task.?one' }, new AbortController().signal))
    .toEqual({ names: ['task.done'] });
  expect(await features.run('mcp_events', { action: 'unsubscribe', name: 'task.*' }, new AbortController().signal)).toEqual({ removed: 1 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM durable_event_subscriptions').get()).toEqual({ n: 0 });
  await features.close(); db.close();
});

it('returns raw prompt data and validates the per-server selector', async () => {
  const db = new DatabaseSync(':memory:');
  const rt = {
    ready: async () => ({ kind: 'ok' as const, value: {} }), capabilities: { prompts: {} },
    transportClosed: new AbortController().signal, stateful: {},
    ops: { prompts: { list: async () => ({ kind: 'ok', value: { prompts: [{ name: 'hello' }] } }) } },
  };
  const features = await createCoreFeatures({ id: 'alpha', descriptor: { name: 'alpha' }, runtime: rt as never, db, options: {} });
  expect(await features.run('mcp_prompts', { action: 'list' }, new AbortController().signal))
    .toEqual({ server: 'alpha', prompts: [{ name: 'hello' }] });
  await expect(features.run('mcp_prompts', { action: 'list', server: 'beta' }, new AbortController().signal)).rejects.toThrow('Unknown MCP server');
  await features.close(); db.close();
});

it('glob matching escapes regexp punctuation', () => {
  expect(globToRegExp('task.*').test('task.done')).toBe(true);
  expect(globToRegExp('task.done').test('taskXdone')).toBe(false);
});
