/**
 * Synthetic users for development (PLAN.md Phase 2, dev tooling). They are real rows with
 * `users.synthetic = true`: matching treats them like anyone else outside production, and the
 * outbox sender never messages them. Nothing in `src/` imports this file.
 */
import {
  ageOn,
  birthDatesWithinYears,
  defaultDatingAgeRange,
  utcDate,
  type Mode,
} from '@samesync/shared';
import type { AnswerValue } from '@samesync/shared/api';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { DEFAULT_MATCHING_PARAMS } from '../../src/domain/matching/params';
import type { PoolKey, PoolScope } from '../../src/domain/matching/types';
import { prng, shuffle } from '../../src/domain/random';
import { newPublicId } from '../../src/ids';

const HOUR = 3_600_000;
const DECK_SIZE = 35;
const GENDERS = ['g.man', 'g.woman'] as const;

export interface SyntheticProfile {
  birthDate: string;
  gender: string | null;
  seeking: string[] | null;
  datingAge: { min: number; max: number } | null;
  items: string[];
  answers: Array<[questionId: string, value: AnswerValue]>;
  /** Hours since "onboarding": decides which fallback tiers the user accepts. */
  waitedHours: number;
}

/** What a synthetic user must fit, when they are made for one real user (`dev:match-me`). */
export interface CompatibleWith {
  birthDate: string;
  gender: string | null;
  seeking: readonly string[] | null;
  datingAge: { min: number; max: number } | null;
}

export interface GenerateOptions {
  pool: PoolKey;
  mode: Mode;
  n: number;
  seed: number;
  now: Date;
  compatibleWith?: CompatibleWith;
}

const pick = <T>(list: readonly T[], random: () => number): T =>
  list[Math.floor(random() * list.length)]!;

/** Born `age` years and up to 364 days before today: exactly `age` years old today. */
function bornAt(age: number, today: string, random: () => number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - age);
  date.setUTCDate(date.getUTCDate() - Math.floor(random() * 364));
  return utcDate(date);
}

function birthDateFor(options: GenerateOptions, today: string, random: () => number): string {
  const target = options.compatibleWith;
  const u18 = options.pool.band === 'u18';
  // The ages of the band; in dating, narrowed to the real user's partner age range.
  let [youngest, oldest] = u18 ? [14, 17] : [18, 35];
  if (target?.datingAge) [youngest, oldest] = [target.datingAge.min, target.datingAge.max];
  for (let attempt = 0; attempt < 500; attempt++) {
    const birthDate = bornAt(
      youngest + Math.floor(random() * (oldest - youngest + 1)),
      today,
      random,
    );
    // u18: at most two calendar years from the real user (Q14).
    if (u18 && target && !birthDatesWithinYears(birthDate, target.birthDate, 2)) continue;
    return birthDate;
  }
  throw new Error('could not find a compatible birth date');
}

/** Items by curator popularity, like real picks: many mainstream, a few known, rarely niche. */
function randomItems(scope: PoolScope, random: () => number): string[] {
  const { popularityPrior } = DEFAULT_MATCHING_PARAMS;
  const picked = scope.items
    .filter((i) => random() < popularityPrior[i.popularity])
    .map((i) => i.id);
  const rest = shuffle(
    scope.items.map((i) => i.id).filter((id) => !picked.includes(id)),
    random,
  );
  while (picked.length < 5 && rest.length > 0) picked.push(rest.pop()!);
  return shuffle(picked, random).slice(0, 30);
}

/** A deck of 35 takes, answered by each take's expected agree share, with some skips. */
function randomAnswers(scope: PoolScope, random: () => number): SyntheticProfile['answers'] {
  const deck = shuffle([...scope.takes], random).slice(0, DECK_SIZE);
  return deck.map((take) => [
    take.id,
    random() < 0.1 ? 'skip' : random() < take.priorAgree ? 'agree' : 'disagree',
  ]);
}

/** Random but realistic profiles for one pool × mode. The same seed gives the same profiles. */
export function generateProfiles(scope: PoolScope, options: GenerateOptions): SyntheticProfile[] {
  if (options.pool.band === 'u18' && options.mode !== 'friends') {
    throw new Error('u18 users are friends-only');
  }
  const random = prng(options.seed);
  const today = utcDate(options.now);
  const target = options.compatibleWith;
  return Array.from({ length: options.n }, (): SyntheticProfile => {
    const birthDate = birthDateFor(options, today, random);
    let dating: Pick<SyntheticProfile, 'gender' | 'seeking' | 'datingAge'> = {
      gender: null,
      seeking: null,
      datingAge: null,
    };
    if (options.mode === 'dating') {
      const gender = target?.seeking?.length ? pick(target.seeking, random) : pick(GENDERS, random);
      const other = GENDERS.filter((g) => g !== gender);
      const roll = random();
      let seeking = roll < 0.7 ? other : roll < 0.85 ? [gender] : [...GENDERS];
      // The real user's gender must be one of the things this user looks for.
      if (target?.gender && !seeking.includes(target.gender)) seeking = [...seeking, target.gender];
      const range = defaultDatingAgeRange(ageOn(birthDate, today));
      if (target) {
        const age = ageOn(target.birthDate, today);
        range.min = Math.min(range.min, age);
        range.max = Math.max(range.max, age);
      }
      dating = { gender, seeking: [...seeking], datingAge: range };
    }
    return {
      birthDate,
      ...dating,
      items: randomItems(scope, random),
      answers: randomAnswers(scope, random),
      waitedHours: Math.floor(random() * 120),
    };
  });
}

/**
 * Profiles that resemble a real user's: they share the user's rarest interests and most of their
 * answers, but always disagree on a few takes (a match needs a disagreement).
 */
export function generateLookalikes(
  scope: PoolScope,
  options: GenerateOptions & { compatibleWith: CompatibleWith },
  real: { items: readonly string[]; answers: ReadonlyArray<readonly [string, AnswerValue]> },
): SyntheticProfile[] {
  const random = prng(options.seed ^ 0x51ed270b);
  const rarity = { niche: 0, known: 1, mainstream: 2 } as const;
  const inScope = new Map(scope.items.map((i) => [i.id, i]));
  const mine = real.items
    .filter((id) => inScope.has(id))
    .sort((a, b) => rarity[inScope.get(a)!.popularity] - rarity[inScope.get(b)!.popularity]);
  const takes = new Set(scope.takes.map((t) => t.id));
  const answered = real.answers.filter(([id, value]) => takes.has(id) && value !== 'skip');

  return generateProfiles(scope, options).map((base, index) => {
    // The rarest shared item differs per lookalike, so it stays rare in the pool.
    const shared = [
      mine[index % Math.max(1, mine.length)],
      ...shuffle([...mine], random).slice(0, 3),
    ];
    const items = [
      ...new Set([...shared.filter((id) => id !== undefined), ...base.items.slice(0, 4)]),
    ];
    const flips = new Set(
      shuffle(
        answered.map(([id]) => id),
        random,
      ).slice(0, Math.max(1, Math.floor(answered.length * 0.15))),
    );
    const answers = answered.map(([id, value]): [string, AnswerValue] => [
      id,
      flips.has(id) ? (value === 'agree' ? 'disagree' : 'agree') : value,
    ]);
    return { ...base, items: items.slice(0, 30), answers, waitedHours: 0 };
  });
}

/** Synthetic Telegram IDs live far above real ones (which are below 2^40 today). */
const SYNTHETIC_TELEGRAM_ID_BASE = 8_000_000_000_000_000;

/** Inserts the profiles as active, onboarded, synthetic users. Returns their IDs. */
export async function insertSyntheticUsers(
  db: pg.Pool,
  pool: PoolKey,
  mode: Mode,
  profiles: readonly SyntheticProfile[],
  now: Date,
): Promise<string[]> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('synthetic users must never be created in production');
  }
  const { rows } = await db.query<{ version: string }>(
    'SELECT version FROM content_releases ORDER BY applied_at DESC LIMIT 1',
  );
  const release = rows[0]?.version;
  if (!release) throw new Error('content is not seeded: run pnpm content:seed');

  const ids: string[] = [];
  const CHUNK = 500;
  for (let start = 0; start < profiles.length; start += CHUNK) {
    const chunk = profiles.slice(start, start + CHUNK);
    const users = chunk.map((profile) => ({ id: uuidv7(), profile }));
    await db.query(
      `INSERT INTO users (id, telegram_id, public_id, locale, locale_confirmed_at, status,
         birth_date, mode, gender, seeking, dating_age_min, dating_age_max, synthetic,
         onboarded_at, last_active_at)
       SELECT u.id, u.telegram_id, u.public_id, $2::locale, $4, 'active', u.birth_date, $3::mode,
         u.gender, CASE WHEN u.seeking IS NULL THEN NULL
           ELSE ARRAY(SELECT jsonb_array_elements_text(u.seeking)) END,
         u.age_min, u.age_max, true, u.onboarded_at, $4
       FROM jsonb_to_recordset($1::jsonb) AS u(id uuid, telegram_id bigint, public_id text,
         birth_date date, gender text, seeking jsonb, age_min smallint, age_max smallint,
         onboarded_at timestamptz)`,
      [
        JSON.stringify(
          users.map(({ id, profile }) => ({
            id,
            telegram_id: SYNTHETIC_TELEGRAM_ID_BASE + Math.floor(Math.random() * 9e14),
            public_id: newPublicId(),
            birth_date: profile.birthDate,
            gender: profile.gender,
            seeking: profile.seeking,
            age_min: profile.datingAge?.min ?? null,
            age_max: profile.datingAge?.max ?? null,
            onboarded_at: new Date(now.getTime() - profile.waitedHours * HOUR).toISOString(),
          })),
        ),
        pool.locale,
        mode,
        now,
      ],
    );
    await db.query(
      `INSERT INTO user_interests (user_id, item_id, added_at)
       SELECT user_id, item_id, $2 FROM jsonb_to_recordset($1::jsonb) AS t(user_id uuid, item_id text)`,
      [
        JSON.stringify(
          users.flatMap(({ id, profile }) =>
            profile.items.map((item_id) => ({ user_id: id, item_id })),
          ),
        ),
        now,
      ],
    );
    await db.query(
      `INSERT INTO answers (user_id, question_id, value, content_release, answered_at)
       SELECT user_id, question_id, value::answer_value, $2, $3
       FROM jsonb_to_recordset($1::jsonb) AS t(user_id uuid, question_id text, value text)`,
      [
        JSON.stringify(
          users.flatMap(({ id, profile }) =>
            profile.answers.map(([question_id, value]) => ({ user_id: id, question_id, value })),
          ),
        ),
        release,
        now,
      ],
    );
    ids.push(...users.map((u) => u.id));
  }
  return ids;
}
