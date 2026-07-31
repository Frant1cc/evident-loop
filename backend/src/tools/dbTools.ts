import { count, desc } from 'drizzle-orm';

import { db, dbPath } from '../db.js';
import { testEvents } from '../schema.js';

export function getDbStatus() {
  const totalEvents = db.select({ value: count() }).from(testEvents).get()?.value ?? 0;
  const latestEvent = db.select().from(testEvents).orderBy(desc(testEvents.id)).limit(1).get();

  return {
    database: dbPath,
    totalEvents,
    latestEvent
  };
}
