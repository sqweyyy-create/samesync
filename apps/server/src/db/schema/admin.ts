import { sql } from 'drizzle-orm';
import { bigint, check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

/** Append-only audit log: the app role may INSERT, never UPDATE or DELETE (migration 0003). */
export const adminActions = pgTable(
  'admin_actions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    adminTelegramId: bigint('admin_telegram_id', { mode: 'number' }).notNull(),
    action: text('action').notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id),
    before: jsonb('before'),
    after: jsonb('after'),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('admin_actions_reason_present', sql`length(btrim(${t.reason})) > 0`),
    check('admin_actions_admin_positive', sql`${t.adminTelegramId} > 0`),
  ],
);
