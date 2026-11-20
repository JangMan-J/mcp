import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { ConversationEvents } from './events.js';

it('does not rewind the subscription cursor on replay of an older event', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const events = new ConversationEvents(db);
    const first = { eventId: 'x', cursor: 'z', name: 'changed', data: 1, timestamp: '2026-01-01T00:00:00Z' };
    events.deliver('a', first);
    events.deliver('a', { ...first, eventId: 'y', cursor: 'b' });
    events.deliver('a', first);
    expect(events.cursor('a')).toBe('b');
  } finally {
    db.close();
  }
});

it('PICD-5: replays after a crash between conversation commit and cursor commit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'picd-events-'));
  const path = join(dir, 'conversation.db');
  let db = new DatabaseSync(path);
  const event = { eventId: 'e2', name: 'changed', data: 2, timestamp: '2026-01-01T00:00:00Z', cursor: 'c2' };
  try {
    let events = new ConversationEvents(db);
    events.deliver('a', { ...event, eventId: 'e1', cursor: 'c1' });
    db.exec(`CREATE TEMP TRIGGER interrupt BEFORE INSERT ON subscription_cursors
      BEGIN SELECT RAISE(ABORT, 'crash before checkpoint'); END`);
    expect(() => events.deliver('a', event)).toThrow('crash before checkpoint');
    db.close();

    db = new DatabaseSync(path);
    events = new ConversationEvents(db);
    expect(events.cursor('a')).toBe('c1');
    const rows = () => db.prepare('SELECT occurrence FROM conversation_events WHERE subscription = ? AND event_id = ?').all('a', 'e2');
    expect(rows()).toEqual([{ occurrence: JSON.stringify(event) }]);
    events.deliver('a', event);
    expect(rows()).toHaveLength(1);
    expect(events.cursor('a')).toBe('c2');

    events.deliver('b', { ...event, cursor: 'other' });
    expect(events.cursor('a')).toBe('c2');
    expect(events.cursor('b')).toBe('other');
    expect(db.prepare('SELECT subscription FROM conversation_events WHERE event_id = ? ORDER BY subscription').all('e2'))
      .toEqual([{ subscription: 'a' }, { subscription: 'b' }]);
  } finally {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
