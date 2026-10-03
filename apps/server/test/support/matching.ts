/** Small hand-made pools for the pure matching engine (no database). */
import { utcDate } from '@samesync/shared';
import { DEFAULT_MATCHING_PARAMS, type MatchingParams } from '../../src/domain/matching/params';
import type { MatchCandidate, PlanInput, PoolScope, Stance } from '../../src/domain/matching/types';

export const NOW = Date.UTC(2026, 9, 3, 12);
export const TODAY = utcDate(new Date(NOW));
export const HOUR = 3_600_000;

const item = (id: string, categoryId: string, popularity: 'mainstream' | 'known' | 'niche') => ({
  id,
  categoryId,
  domain: id.split('.')[1] as PoolScope['items'][number]['domain'],
  popularity,
});

/** Twelve takes: t01–t10 are even (prior 0.5), t11 is a majority view, t12 a minority one. */
export const TAKES = [
  ...Array.from({ length: 10 }, (_, i) => ({
    id: `q.t${String(i + 1).padStart(2, '0')}`,
    priorAgree: 0.5,
  })),
  { id: 'q.t11', priorAgree: 0.9 },
  { id: 'q.t12', priorAgree: 0.1 },
];

export const SCOPE: PoolScope = {
  items: [
    item('i.music.niche_a', 'c.music.post_punk', 'niche'),
    item('i.music.niche_b', 'c.music.post_punk', 'niche'),
    item('i.music.known_a', 'c.music.rock', 'known'),
    item('i.music.known_b', 'c.music.rock', 'known'),
    item('i.music.star', 'c.music.pop', 'mainstream'),
    item('i.games.indie_a', 'c.games.indie', 'known'),
    item('i.games.indie_b', 'c.games.indie', 'known'),
    item('i.games.shooter', 'c.games.shooters', 'mainstream'),
    item('i.shows.anime_a', 'c.shows.anime', 'known'),
    item('i.shows.anime_b', 'c.shows.anime', 'known'),
    item('i.movies.auteur', 'c.movies.auteur', 'niche'),
    item('i.books.manga', 'c.books.manga', 'known'),
    ...Array.from({ length: 12 }, (_, i) =>
      item(`i.memes.filler_${String(i + 1).padStart(2, '0')}`, `c.memes.filler_${i + 1}`, 'known'),
    ),
  ],
  takes: TAKES,
  aliases: ['a.otter', 'a.fox', 'a.owl', 'a.lynx', 'a.heron', 'a.seal'],
};

/**
 * Answers written as one character per take in `TAKES` order: `A` agree, `D` disagree, anything
 * else (`-`) not answered. `answers('AAAAAD')` answers the first six takes.
 */
export function answers(pattern: string): Array<[string, Stance]> {
  const out: Array<[string, Stance]> = [];
  [...pattern].forEach((char, i) => {
    const take = TAKES[i];
    if (!take) throw new Error(`pattern is longer than the ${TAKES.length} takes`);
    if (char === 'A') out.push([take.id, 'agree']);
    if (char === 'D') out.push([take.id, 'disagree']);
  });
  return out;
}

/** Born `years` years (and `days` days) before today: `years` old today when `days` is 0. */
export function bornYearsAgo(years: number, days = 0): string {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - days);
  return utcDate(d);
}

let counter = 0;

/** An eligible adult in ru friends mode who onboarded just now; override what the test is about. */
export function candidate(over: Partial<MatchCandidate> = {}): MatchCandidate {
  counter += 1;
  return {
    id: `user-${String(counter).padStart(5, '0')}`,
    birthDate: bornYearsAgo(25, 40),
    locale: 'ru',
    mode: 'friends',
    status: 'active',
    botReachable: true,
    synthetic: false,
    lastActiveAt: NOW,
    waitingSince: NOW,
    gender: null,
    seeking: null,
    datingAgeMin: null,
    datingAgeMax: null,
    recentMatches: 0,
    openMatches: 0,
    aliasesInUse: [],
    items: [],
    answers: answers('AAAAAD'),
    ...over,
  };
}

export function planInput(
  users: readonly MatchCandidate[],
  over: Partial<Omit<PlanInput, 'params'>> & { params?: Partial<MatchingParams> } = {},
): PlanInput {
  const { params, ...rest } = over;
  return {
    pool: { band: 'adult', locale: 'ru' },
    mode: 'friends',
    today: TODAY,
    now: NOW,
    seed: 1,
    users,
    scope: SCOPE,
    excludedPairs: [],
    alreadyMatched: [],
    allowSynthetic: true,
    ...rest,
    params: { ...DEFAULT_MATCHING_PARAMS, ...params },
  };
}
