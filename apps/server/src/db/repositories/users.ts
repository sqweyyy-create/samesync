import type { Locale } from '@samesync/shared';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { newPublicId } from '../../ids';
import type { Db } from '../client';
import { users } from '../schema/index';

export interface UserRecord {
  id: string;
  publicId: string;
  locale: Locale;
  status: (typeof users.$inferSelect)['status'];
}

export interface UsersRepository {
  /**
   * Creates the user on first authenticated contact, or refreshes `last_active_at`.
   * Never changes the stored locale: once a user exists, locale is theirs to change (Phase 1).
   */
  upsertOnAuth(input: { telegramId: number; locale: Locale; now: Date }): Promise<UserRecord>;
}

const PUBLIC_ID_CONSTRAINT = 'users_public_id_unique';
const MAX_ATTEMPTS = 3;

function isPublicIdCollision(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const pgError = e as Error & { code?: string; constraint?: string };
    if (pgError.code === '23505' && pgError.constraint === PUBLIC_ID_CONSTRAINT) return true;
  }
  return false;
}

export function createUsersRepository(db: Db): UsersRepository {
  return {
    async upsertOnAuth({ telegramId, locale, now }) {
      for (let attempt = 1; ; attempt++) {
        try {
          const [row] = await db
            .insert(users)
            .values({
              id: uuidv7(),
              telegramId,
              publicId: newPublicId(),
              locale,
              lastActiveAt: now,
            })
            .onConflictDoUpdate({
              target: users.telegramId,
              set: { lastActiveAt: sql`greatest(${users.lastActiveAt}, excluded.last_active_at)` },
            })
            .returning({
              id: users.id,
              publicId: users.publicId,
              locale: users.locale,
              status: users.status,
            });
          if (!row) throw new Error('users upsert returned no row');
          return row;
        } catch (error) {
          if (attempt < MAX_ATTEMPTS && isPublicIdCollision(error)) continue;
          throw error;
        }
      }
    },
  };
}
