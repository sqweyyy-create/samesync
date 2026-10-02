import { randomInt } from 'node:crypto';
import { utcDate } from '@samesync/shared';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { newPublicId } from '../../src/ids';

/** Today's UTC date as YYYY-MM-DD, the same "today" the DB uses (vc_today()). */
export const todayUtc = () => utcDate(new Date());

/** A birth date `years` years before today, shifted by `days` (positive = later, i.e. younger). */
export function birthDateYearsAgo(years: number, days = 0): string {
  const d = new Date(`${todayUtc()}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDate(d);
}

export interface InsertUser {
  telegramId?: number;
  birthDate?: string | null;
  locale?: 'ru' | 'en';
  status?: string;
  mode?: 'friends' | 'dating' | null;
  gender?: string | null;
  seeking?: string[] | null;
  username?: string | null;
}

/** Inserts a user with plain SQL on `pool` (pass the app-role pool to test the real privileges). */
export async function insertUser(
  pool: pg.Pool,
  over: InsertUser = {},
): Promise<{ id: string; telegramId: number }> {
  const id = uuidv7();
  const telegramId = over.telegramId ?? randomInt(1, 2 ** 40);
  await pool.query(
    `INSERT INTO users (id, telegram_id, public_id, locale, status, birth_date, mode, gender, seeking, username, last_active_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      id,
      telegramId,
      newPublicId(),
      over.locale ?? 'ru',
      over.status ?? 'onboarding',
      over.birthDate ?? null,
      over.mode ?? null,
      over.gender ?? null,
      over.seeking ?? null,
      over.username ?? null,
    ],
  );
  return { id, telegramId };
}
