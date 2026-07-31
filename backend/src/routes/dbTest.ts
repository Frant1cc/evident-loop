import { count, desc } from 'drizzle-orm';
import { Router } from 'express';

import { db, dbPath } from '../db.js';
import { success } from '../response.js';
import { testEvents } from '../schema.js';

export const dbTestRouter = Router();

dbTestRouter.get('/db-test', (_req, res) => {
  const message = `db test ${new Date().toISOString()}`;

  db.insert(testEvents).values({ message }).run();

  const totalEvents = db.select({ value: count() }).from(testEvents).get()?.value ?? 0;
  const latestEvent = db.select().from(testEvents).orderBy(desc(testEvents.id)).limit(1).get();

  res.json(
    success({
      database: dbPath,
      totalEvents,
      latestEvent
    })
  );
});
