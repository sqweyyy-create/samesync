/** Chats, messages and consents written with plain SQL, like an attacker or a buggy code path would. */
import type { Band, Locale } from '@samesync/shared';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { TestUser } from './fixtures';
import { insertGame, insertPredictions, markDone, toResultsReady } from './games';
import { insertActiveUser, insertMatch } from './matches';
import { birthDateYearsAgo, type InsertUser } from './users';

/** A user row and the Telegram account behind it. */
export interface Person {
  id: string;
  telegramId: number;
}

export interface Chat {
  matchId: string;
  /** User A of the match (the lower ID) and user B, with their Telegram IDs. */
  a: string;
  b: string;
  telegramA: number;
  telegramB: number;
  /** The two people in the order they were given or created. */
  first: Person;
  second: Person;
}

let people = 0;

/**
 * The Telegram account of a person as updates carry it. Every part of the identity is unlike
 * anything else in a test, so a leak scanner can look for each of them.
 */
export function telegramUser(person: Person, locale: 'ru' | 'en' = 'ru'): TestUser {
  const n = ++people;
  return {
    id: person.telegramId,
    first_name: `Имярек${n}`,
    last_name: `Фамильев${n}`,
    username: `secret_handle_${n}`,
    language_code: locale,
  };
}

/**
 * Two users whose game is finished: the match is `results_ready`, so its chat is open. Everything
 * goes through the real triggers. Adults (25) in the ru pool unless a test says otherwise; `a` is
 * user A of the match, whose alias is `a.fox`, and `b` is user B, `a.owl`.
 */
export async function insertChat(
  pool: pg.Pool,
  over: {
    years?: number;
    band?: Band;
    locale?: Locale;
    first?: InsertUser;
    second?: InsertUser;
    /** Two people who exist already, instead of two new ones. */
    between?: readonly [Person, Person];
    /** Content alias IDs: how the first appears to the second, and the second to the first. */
    seenAs?: readonly [string, string];
  } = {},
): Promise<Chat> {
  const years = over.years ?? 25;
  const base = { birthDate: birthDateYearsAgo(years), locale: over.locale ?? 'ru' };
  const first = over.between?.[0] ?? (await insertActiveUser(pool, { ...base, ...over.first }));
  const second = over.between?.[1] ?? (await insertActiveUser(pool, { ...base, ...over.second }));
  const match = await insertMatch(pool, {
    a: first.id,
    b: second.id,
    band: over.band ?? (years >= 18 ? 'adult' : 'u18'),
    locale: over.locale ?? 'ru',
    ...(over.seenAs ? { seenAs: over.seenAs } : {}),
  });
  await insertGame(pool, match.id);
  for (const [side, predictorId] of [
    ['a', match.userA],
    ['b', match.userB],
  ] as const) {
    await insertPredictions(pool, { matchId: match.id, predictorId });
    await markDone(pool, match.id, side);
  }
  await toResultsReady(pool, match.id);
  const telegramOf = (id: string) => (id === first.id ? first.telegramId : second.telegramId);
  return {
    matchId: match.id,
    a: match.userA,
    b: match.userB,
    telegramA: telegramOf(match.userA),
    telegramB: telegramOf(match.userB),
    first,
    second,
  };
}

/** An active adult (25) of the ru pool, to put into several chats. */
export const insertAdult = (pool: pg.Pool, over: InsertUser = {}): Promise<Person> =>
  insertActiveUser(pool, { birthDate: birthDateYearsAgo(25), ...over });

export interface InsertMessage {
  matchId: string;
  senderId: string;
  body?: string | null;
  verdict?: 'delivered' | 'blocked_by_filter' | 'rejected';
  reason?: string | null;
  senderTgMessageId?: number | null;
  recipientTgMessageId?: number | null;
  deliveredAt?: Date | null;
}

/** Stores a message with plain SQL: only the database decides whether it may exist. */
export async function insertMessage(pool: pg.Pool, input: InsertMessage): Promise<{ id: string }> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO messages (id, match_id, sender_id, body, verdict, reason, sender_tg_message_id,
       recipient_tg_message_id, delivered_at, purge_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '30 days')`,
    [
      id,
      input.matchId,
      input.senderId,
      input.body === undefined ? 'привет' : input.body,
      input.verdict ?? 'delivered',
      input.reason ?? null,
      input.senderTgMessageId ?? null,
      input.recipientTgMessageId ?? null,
      input.deliveredAt ?? null,
    ],
  );
  return { id };
}

/** A message that has reached the recipient: stored, then marked delivered, as the relay does. */
export async function insertDeliveredMessage(
  pool: pg.Pool,
  input: InsertMessage,
): Promise<{ id: string }> {
  const message = await insertMessage(pool, input);
  await pool.query('UPDATE messages SET delivered_at = now() WHERE id = $1', [message.id]);
  return message;
}

/** Moves a chat to `active`, as the relay does after the first delivered message. */
export const startChat = (pool: pg.Pool, matchId: string) =>
  pool.query(
    `UPDATE matches SET status = 'active', first_message_at = now(), chat_deadline_at = NULL
     WHERE id = $1`,
    [matchId],
  );

export interface MessageRow {
  id: string;
  match_id: string;
  sender_id: string;
  body: string | null;
  verdict: string;
  reason: string | null;
  sender_tg_message_id: string | null;
  recipient_tg_message_id: string | null;
  delivered: boolean;
}

export async function messageRows(pool: pg.Pool, matchId: string): Promise<MessageRow[]> {
  const { rows } = await pool.query<MessageRow>(
    `SELECT id, match_id, sender_id, body, verdict::text AS verdict, reason, sender_tg_message_id,
       recipient_tg_message_id, delivered_at IS NOT NULL AS delivered
     FROM messages WHERE match_id = $1 ORDER BY created_at, id`,
    [matchId],
  );
  return rows;
}

export const insertConsent = (pool: pg.Pool, matchId: string, userId: string) =>
  pool.query(
    'INSERT INTO reveal_consents (match_id, user_id, consented_at) VALUES ($1, $2, now())',
    [matchId, userId],
  );

export async function consentRows(pool: pg.Pool, matchId: string) {
  const { rows } = await pool.query<{ user_id: string; revealed: boolean }>(
    `SELECT user_id, revealed_at IS NOT NULL AS revealed FROM reveal_consents
     WHERE match_id = $1 ORDER BY user_id`,
    [matchId],
  );
  return rows;
}

export const insertBlock = (ownerPool: pg.Pool, blockerId: string, blockedId: string) =>
  ownerPool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
    blockerId,
    blockedId,
  ]);

export async function activeMatchOf(pool: pg.Pool, userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ active_match_id: string | null }>(
    'SELECT active_match_id FROM users WHERE id = $1',
    [userId],
  );
  return rows[0]?.active_match_id ?? null;
}
