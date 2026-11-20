import type { DatabaseSync } from 'node:sqlite';
import type { Occurrence } from '../../packages/ext-events/src/model.js';

/** PICD-5. Use for an enabled Events stream, delivering in order per subscription. */
export class ConversationEvents {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_events (
        subscription TEXT NOT NULL, event_id TEXT NOT NULL, occurrence TEXT NOT NULL,
        PRIMARY KEY (subscription, event_id)
      );
      CREATE TABLE IF NOT EXISTS subscription_cursors (
        subscription TEXT PRIMARY KEY NOT NULL, cursor TEXT NOT NULL
      );
    `);
  }

  cursor(subscription: string): string | null {
    const row = this.db.prepare('SELECT cursor FROM subscription_cursors WHERE subscription = ?').get(subscription);
    return row ? String(row.cursor) : null;
  }

  deliver(subscription: string, event: Occurrence): void {
    // Two autocommits: a restart between them redelivers the event, but cannot skip it.
    if (this.db.isTransaction) throw new Error('Event delivery requires autocommit');
    this.db.prepare(`INSERT INTO conversation_events VALUES (?, ?, ?)
      ON CONFLICT (subscription, event_id) DO NOTHING`).run(subscription, event.eventId, JSON.stringify(event));
    if (event.cursor !== null) {
      this.db.prepare(`INSERT INTO subscription_cursors VALUES (?, ?)
        ON CONFLICT (subscription) DO UPDATE SET cursor = excluded.cursor`).run(subscription, event.cursor);
    }
  }
}
