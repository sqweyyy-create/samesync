import type { Band, Locale, Mode } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { newPublicId } from '../../ids';
import type { Db } from '../client';
import { users } from '../schema/index';

/** The caller's own row. Never handed to other users. */
export interface UserRecord {
  id: string;
  publicId: string;
  locale: Locale;
  localeConfirmedAt: Date | null;
  status: UserStatus;
  birthDate: string | null;
  ageBand: Band | null;
  mode: Mode | null;
  gender: string | null;
  seeking: string[] | null;
  datingAgeMin: number | null;
  datingAgeMax: number | null;
  onboardedAt: Date | null;
}

const columns = {
  id: users.id,
  publicId: users.publicId,
  locale: users.locale,
  localeConfirmedAt: users.localeConfirmedAt,
  status: users.status,
  birthDate: users.birthDate,
  ageBand: users.ageBand,
  mode: users.mode,
  gender: users.gender,
  seeking: users.seeking,
  datingAgeMin: users.datingAgeMin,
  datingAgeMax: users.datingAgeMax,
  onboardedAt: users.onboardedAt,
};

export interface UsersRepository {
  /**
   * Creates the user on first authenticated contact, or refreshes `last_active_at`.
   * Never changes the stored locale: once a user exists, the locale is theirs to change (Q13).
   */
  upsertOnAuth(input: { telegramId: number; locale: Locale; now: Date }): Promise<UserRecord>;
  /** Stored locale of a known user, for bot replies (Q13). */
  localeOf(telegramId: number): Promise<Locale | null>;
  /**
   * Stores the current Telegram username, but only for users who are adults right now (age from
   * birth_date in SQL). Never stores anything for u18 or unknown ages (CLAUDE.md invariant 6).
   */
  storeUsernameIfAdult(telegramId: number, username: string | null): Promise<void>;
  /** Q16: an ineligible user whose live age reached 14 continues onboarding. */
  reopenIfFourteen(userId: string): Promise<UserRecord | null>;
  confirmLocale(userId: string, locale: Locale, now: Date): Promise<UserRecord>;
  /** Write-once: null if a birth date was already set. */
  setBirthDateOnce(
    userId: string,
    input: { birthDate: string; status: UserStatus; mode: Mode | null },
  ): Promise<UserRecord | null>;
  /** Dating fields (gender, seeking, partner age range) are all set, or all null for friends. */
  setMode(
    userId: string,
    input: {
      mode: Mode;
      gender: string | null;
      seeking: string[] | null;
      datingAge: { min: number; max: number } | null;
    },
  ): Promise<UserRecord>;
  complete(
    userId: string,
    input: { status: UserStatus; timezone: string | null; now: Date },
  ): Promise<UserRecord>;
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

function one<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('expected one row');
  return row;
}

export function createUsersRepository(db: Db): UsersRepository {
  return {
    async upsertOnAuth({ telegramId, locale, now }) {
      for (let attempt = 1; ; attempt++) {
        try {
          return one(
            await db
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
                set: {
                  lastActiveAt: sql`greatest(${users.lastActiveAt}, excluded.last_active_at)`,
                },
              })
              .returning(columns),
          );
        } catch (error) {
          if (attempt < MAX_ATTEMPTS && isPublicIdCollision(error)) continue;
          throw error;
        }
      }
    },

    async localeOf(telegramId) {
      const [row] = await db
        .select({ locale: users.locale })
        .from(users)
        .where(eq(users.telegramId, telegramId));
      return row?.locale ?? null;
    },

    async storeUsernameIfAdult(telegramId, username) {
      await db
        .update(users)
        .set({ username })
        .where(
          and(
            eq(users.telegramId, telegramId),
            sql`${users.birthDate} IS NOT NULL`,
            sql`coalesce(vc_age_years(${users.birthDate}, vc_today()) >= 18, false)`,
            sql`${users.username} IS DISTINCT FROM ${username}`,
          ),
        );
    },

    async reopenIfFourteen(userId) {
      const [row] = await db
        .update(users)
        .set({ status: 'onboarding' })
        .where(
          and(
            eq(users.id, userId),
            eq(users.status, 'ineligible'),
            sql`coalesce(vc_age_years(${users.birthDate}, vc_today()) >= 14, false)`,
          ),
        )
        .returning(columns);
      return row ?? null;
    },

    async confirmLocale(userId, locale, now) {
      return one(
        await db
          .update(users)
          .set({ locale, localeConfirmedAt: sql`coalesce(${users.localeConfirmedAt}, ${now})` })
          .where(eq(users.id, userId))
          .returning(columns),
      );
    },

    async setBirthDateOnce(userId, { birthDate, status, mode }) {
      const [row] = await db
        .update(users)
        .set({ birthDate, status, mode })
        .where(and(eq(users.id, userId), isNull(users.birthDate)))
        .returning(columns);
      return row ?? null;
    },

    async setMode(userId, { mode, gender, seeking, datingAge }) {
      return one(
        await db
          .update(users)
          .set({
            mode,
            gender,
            seeking,
            datingAgeMin: datingAge?.min ?? null,
            datingAgeMax: datingAge?.max ?? null,
          })
          .where(eq(users.id, userId))
          .returning(columns),
      );
    },

    async complete(userId, { status, timezone, now }) {
      return one(
        await db
          .update(users)
          .set({ status, timezone, onboardedAt: sql`coalesce(${users.onboardedAt}, ${now})` })
          .where(eq(users.id, userId))
          .returning(columns),
      );
    },
  };
}
