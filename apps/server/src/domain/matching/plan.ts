/**
 * One matching run for one pool × mode, as a pure function of its input (PLAN.md §5): rarity
 * statistics, hard filters, tiered scoring and greedy assignment. No I/O and no clock, so the same
 * input and seed always give the same pairs. It runs in a worker thread in production.
 *
 * Safety: the caller's DB query already selects one pool, but nothing here relies on that. Every
 * user is re-checked against the pool with the band derived from the birth date, and the hard
 * filters (u18 birth dates at most 2 years apart, dating compatibility, blocks, no rematch) apply
 * at every tier. The `matches` insert trigger checks the same rules again in the database.
 */
import { ageOn, bandFor, nthBirthday, type Band } from '@samesync/shared';
import { prng, shuffle } from '../random';
import { pickAliases } from './alias';
import { U18_MAX_BIRTH_GAP_YEARS } from './params';
import { anyOfPrior, featureKey, rarityWeight, smoothedShare } from './rarity';
import { relaxedTier, waitShare } from './tiers';
import type {
  FeatureStat,
  Ineligibility,
  MatchCandidate,
  PlanInput,
  PlanResult,
  PlannedPair,
  PoolScope,
  Teaser,
  Tier,
} from './types';

const DAY = 86_400_000;

/** The band a birth date gives today; null for anything that isn't a valid age of 14 or more. */
export function liveBand(birthDate: string, today: string): Band | null {
  try {
    return bandFor(ageOn(birthDate, today));
  } catch {
    return null; // fail closed: an unreadable or future birth date belongs to no pool
  }
}

type PoolContext = Pick<PlanInput, 'pool' | 'today' | 'allowSynthetic'>;
type RunContext = PoolContext & Pick<PlanInput, 'mode' | 'now' | 'params'>;

/** Counts toward the pool's statistics: active, in this locale and, by birth date, in this band. */
function isPoolMember(user: MatchCandidate, ctx: PoolContext): boolean {
  return (
    user.status === 'active' &&
    user.mode !== null &&
    user.locale === ctx.pool.locale &&
    liveBand(user.birthDate, ctx.today) === ctx.pool.band &&
    (ctx.allowSynthetic || !user.synthetic)
  );
}

/** Why `user` can't be matched in this run, or null. Checked before any pair is scored. */
export function userIneligibility(
  user: MatchCandidate,
  ctx: RunContext,
  alreadyMatched: ReadonlySet<string> = new Set(),
): Ineligibility | null {
  if (user.status !== 'active') return 'not_active';
  if (user.locale !== ctx.pool.locale || liveBand(user.birthDate, ctx.today) !== ctx.pool.band)
    return 'other_pool';
  if (user.synthetic && !ctx.allowSynthetic) return 'synthetic';
  if (user.mode !== ctx.mode) return 'other_mode';
  if (!user.botReachable) return 'unreachable';
  if (ctx.now - user.lastActiveAt > ctx.params.activeWithinDays * DAY) return 'inactive';
  if (alreadyMatched.has(user.id)) return 'already_matched';
  if (user.recentMatches >= ctx.params.dailyLimit) return 'daily_limit';
  if (user.openMatches >= ctx.params.openLimit) return 'open_limit';
  if (
    ctx.mode === 'dating' &&
    (user.gender === null ||
      !user.seeking?.length ||
      user.datingAgeMin === null ||
      user.datingAgeMax === null)
  )
    return 'incomplete_dating_profile';
  return null;
}

/** The features of one pool × mode, with a number for each (bit positions and array slots). */
interface Universe {
  itemIds: string[];
  itemIndex: Map<string, number>;
  itemCategory: Int32Array;
  itemPrior: Float64Array;
  categoryIds: string[];
  categoryDomain: Int32Array;
  domainIds: string[];
  takeIds: string[];
  takeIndex: Map<string, number>;
  takePrior: Float64Array;
}

function buildUniverse(scope: PoolScope, popularityPrior: Record<string, number>): Universe {
  const items = [...scope.items].sort((a, b) => (a.id < b.id ? -1 : 1));
  const categoryIds = [...new Set(items.map((i) => i.categoryId))].sort();
  const domainIds = [...new Set(items.map((i) => i.domain as string))].sort();
  const categoryIndex = new Map(categoryIds.map((id, i) => [id, i]));
  const domainIndex = new Map(domainIds.map((id, i) => [id, i]));
  const categoryDomain = new Int32Array(categoryIds.length);
  for (const item of items) {
    categoryDomain[categoryIndex.get(item.categoryId)!] = domainIndex.get(item.domain)!;
  }
  const takes = [...scope.takes].sort((a, b) => (a.id < b.id ? -1 : 1));
  return {
    itemIds: items.map((i) => i.id),
    itemIndex: new Map(items.map((item, i) => [item.id, i])),
    itemCategory: Int32Array.from(items, (i) => categoryIndex.get(i.categoryId)!),
    itemPrior: Float64Array.from(items, (i) => popularityPrior[i.popularity] ?? 0.5),
    categoryIds,
    categoryDomain,
    domainIds,
    takeIds: takes.map((t) => t.id),
    takeIndex: new Map(takes.map((take, i) => [take.id, i])),
    takePrior: Float64Array.from(takes, (t) => t.priorAgree),
  };
}

/** One user's features inside the universe (anything outside the pool's scope is dropped). */
interface Profile {
  items: number[];
  categories: number[];
  domains: number[];
  agree: number[];
  disagree: number[];
}

function profileOf(user: MatchCandidate, u: Universe): Profile {
  const items = new Set<number>();
  const categories = new Set<number>();
  const domains = new Set<number>();
  for (const id of user.items) {
    const index = u.itemIndex.get(id);
    if (index === undefined) continue;
    items.add(index);
    const category = u.itemCategory[index]!;
    categories.add(category);
    domains.add(u.categoryDomain[category]!);
  }
  const stance = new Map<number, 'agree' | 'disagree'>();
  for (const [questionId, value] of user.answers) {
    const index = u.takeIndex.get(questionId);
    if (index !== undefined && (value === 'agree' || value === 'disagree'))
      stance.set(index, value);
  }
  const side = (wanted: 'agree' | 'disagree') =>
    [...stance].filter(([, value]) => value === wanted).map(([index]) => index);
  return {
    items: [...items],
    categories: [...categories],
    domains: [...domains],
    agree: side('agree'),
    disagree: side('disagree'),
  };
}

interface Weights {
  item: Float64Array;
  category: Float64Array;
  domain: Float64Array;
  agree: Float64Array;
  disagree: Float64Array;
}

/** Rarity weights from the pool's own members, plus the rows for `feature_stats`. */
function computeStats(
  profiles: readonly Profile[],
  u: Universe,
  alpha: number,
): { weights: Weights; stats: FeatureStat[] } {
  const poolSize = profiles.length;
  const count = {
    item: new Int32Array(u.itemIds.length),
    category: new Int32Array(u.categoryIds.length),
    domain: new Int32Array(u.domainIds.length),
    agree: new Int32Array(u.takeIds.length),
    disagree: new Int32Array(u.takeIds.length),
  };
  for (const p of profiles) {
    for (const i of p.items) count.item[i]!++;
    for (const c of p.categories) count.category[c]!++;
    for (const d of p.domains) count.domain[d]!++;
    for (const q of p.agree) count.agree[q]!++;
    for (const q of p.disagree) count.disagree[q]!++;
  }

  // A category's (domain's) prior: the chance of picking at least one of its items.
  const categoryPriors: number[][] = u.categoryIds.map(() => []);
  const domainPriors: number[][] = u.domainIds.map(() => []);
  u.itemIds.forEach((_, i) => {
    const category = u.itemCategory[i]!;
    categoryPriors[category]!.push(u.itemPrior[i]!);
    domainPriors[u.categoryDomain[category]!]!.push(u.itemPrior[i]!);
  });

  const weights: Weights = {
    item: new Float64Array(u.itemIds.length),
    category: new Float64Array(u.categoryIds.length),
    domain: new Float64Array(u.domainIds.length),
    agree: new Float64Array(u.takeIds.length),
    disagree: new Float64Array(u.takeIds.length),
  };
  const stats: FeatureStat[] = [];
  const record = (key: string, n: number, total: number, prior: number): number => {
    const weight = rarityWeight(smoothedShare(n, total, prior, alpha));
    stats.push({ key, n, total, weight });
    return weight;
  };
  u.itemIds.forEach((id, i) => {
    weights.item[i] = record(featureKey.item(id), count.item[i]!, poolSize, u.itemPrior[i]!);
  });
  u.categoryIds.forEach((id, c) => {
    weights.category[c] = record(
      featureKey.category(id),
      count.category[c]!,
      poolSize,
      anyOfPrior(categoryPriors[c]!),
    );
  });
  u.domainIds.forEach((id, d) => {
    weights.domain[d] = record(
      featureKey.domain(id),
      count.domain[d]!,
      poolSize,
      anyOfPrior(domainPriors[d]!),
    );
  });
  u.takeIds.forEach((id, q) => {
    // Among the people who answered the take: a deck shows only part of the bank to each user.
    const answered = count.agree[q]! + count.disagree[q]!;
    const prior = u.takePrior[q]!;
    weights.agree[q] = record(featureKey.take(id, 'agree'), count.agree[q]!, answered, prior);
    weights.disagree[q] = record(
      featureKey.take(id, 'disagree'),
      count.disagree[q]!,
      answered,
      1 - prior,
    );
  });
  return { weights, stats };
}

const words = (bits: number) => Math.max(1, Math.ceil(bits / 32));

function popcount(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Days since 1970-01-01 for a `YYYY-MM-DD` date. */
const dayNumber = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);

/** Result of scoring one pair; `tier` 0 means the pair can't be matched in this run. */
interface PairScore {
  tier: 0 | Tier;
  score: number;
}

/** All-pairs scoring is meant for pools of a few thousand users (PLAN.md §5, "Scale"). */
const MAX_CANDIDATES = 20_000;

/** The pool's statistics and candidates, encoded so that scoring one pair is cheap. */
function prepare(input: PlanInput) {
  const { pool, mode, params, now } = input;
  if (pool.band === 'u18' && mode !== 'friends') throw new Error('u18 pools are friends-only');

  // Members of this pool (both modes) define rarity; duplicates and outsiders are dropped.
  const byId = new Map<string, MatchCandidate>();
  for (const user of input.users) if (isPoolMember(user, input)) byId.set(user.id, user);
  const members = [...byId.values()];
  const universe = buildUniverse(input.scope, params.popularityPrior);
  const profiles = new Map(members.map((user) => [user.id, profileOf(user, universe)]));
  const { weights, stats } = computeStats([...profiles.values()], universe, params.alpha);

  const itemWords = words(universe.itemIds.length);
  const takeWords = words(universe.takeIds.length);
  const categoryWords = words(universe.categoryIds.length);
  const domainWords = words(universe.domainIds.length);

  // A user's own weight (step 4 of §5): what they would share with an identical twin.
  const massOf = (p: Profile) => {
    let mass = 0;
    for (const i of p.items) mass += weights.item[i]!;
    for (const q of p.agree) mass += params.beta * weights.agree[q]!;
    for (const q of p.disagree) mass += params.beta * weights.disagree[q]!;
    return mass;
  };

  // Candidates in a seeded order: the order only breaks ties between equal scores.
  const alreadyMatched = new Set(input.alreadyMatched);
  const candidates = shuffle(
    members
      .filter(
        (user) =>
          userIneligibility(user, input, alreadyMatched) === null &&
          massOf(profiles.get(user.id)!) > 0,
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    prng(input.seed),
  );
  const n = candidates.length;
  if (n > MAX_CANDIDATES) {
    throw new Error(`${n} candidates in one pool: all-pairs scoring needs the candidate index`);
  }
  if (universe.domainIds.length > 31) throw new Error('more than 31 domains are not supported');

  // --- Encode every candidate into flat arrays, so scoring a pair is a few bit operations. ------
  const itemBits = new Int32Array(n * itemWords);
  const agreeBits = new Int32Array(n * takeWords);
  const disagreeBits = new Int32Array(n * takeWords);
  const categoryBits = new Int32Array(n * categoryWords);
  const domainBits = new Int32Array(n * domainWords);
  const mass = new Float64Array(n);
  const relaxed = new Uint8Array(n);
  const wait = new Float64Array(n);
  const birthDay = new Int32Array(n);
  /** The latest birth date a u18 partner may have: this user's 2nd birthday (Q14). */
  const latestPartnerBirthDay = new Int32Array(n);
  const age = new Int16Array(n);
  const ageMin = new Int16Array(n);
  const ageMax = new Int16Array(n);
  const gender = new Int8Array(n);
  const seekingMask = new Int32Array(n);
  const genderIndex = new Map<string, number>();
  const genderBit = (id: string) => {
    let index = genderIndex.get(id);
    if (index === undefined) {
      index = genderIndex.size;
      if (index > 30) throw new Error('more than 31 dating options are not supported');
      genderIndex.set(id, index);
    }
    return index;
  };
  const setBits = (bits: Int32Array, row: number, perRow: number, indexes: readonly number[]) => {
    for (const index of indexes) bits[row * perRow + (index >>> 5)]! |= 1 << (index & 31);
  };

  candidates.forEach((user, row) => {
    const p = profiles.get(user.id)!;
    setBits(itemBits, row, itemWords, p.items);
    setBits(agreeBits, row, takeWords, p.agree);
    setBits(disagreeBits, row, takeWords, p.disagree);
    setBits(categoryBits, row, categoryWords, p.categories);
    setBits(domainBits, row, domainWords, p.domains);
    mass[row] = massOf(p);
    relaxed[row] = relaxedTier(user.waitingSince, now, params);
    wait[row] = waitShare(user.waitingSince, now, params);
    birthDay[row] = dayNumber(user.birthDate);
    latestPartnerBirthDay[row] = dayNumber(nthBirthday(user.birthDate, U18_MAX_BIRTH_GAP_YEARS));
    age[row] = ageOn(user.birthDate, input.today);
    if (mode === 'dating') {
      gender[row] = genderBit(user.gender!);
      seekingMask[row] = user.seeking!.reduce((mask, id) => mask | (1 << genderBit(id)), 0);
      ageMin[row] = user.datingAgeMin!;
      ageMax[row] = user.datingAgeMax!;
    }
  });

  // Pairs that may never be matched (matched before, blocked), as one bit per pair.
  const rowOf = new Map(candidates.map((user, row) => [user.id, row]));
  const excluded = new Uint8Array(Math.ceil((n * n) / 8));
  for (const [first, second] of input.excludedPairs) {
    const a = rowOf.get(first);
    const b = rowOf.get(second);
    if (a === undefined || b === undefined) continue;
    const bit = Math.min(a, b) * n + Math.max(a, b);
    excluded[bit >>> 3]! |= 1 << (bit & 7);
  }

  const isU18 = pool.band === 'u18';
  const isDating = mode === 'dating';
  const { beta, lambdaCategory, lambdaDomain, gamma, nicheWeight, minCommonTakes } = params;
  const sharedItemCategories = new Int32Array(categoryWords);

  /** Hard filters first, then the tier the pair qualifies for and its score. `i < j`. */
  const scorePair = (i: number, j: number, out: PairScore): void => {
    out.tier = 0;
    out.score = 0;
    const bit = i * n + j;
    if (excluded[bit >>> 3]! & (1 << (bit & 7))) return;
    if (isU18) {
      // The younger one is born no later than the older one's 2nd birthday.
      const within =
        birthDay[i]! <= birthDay[j]!
          ? birthDay[j]! <= latestPartnerBirthDay[i]!
          : birthDay[i]! <= latestPartnerBirthDay[j]!;
      if (!within) return;
    }
    if (isDating) {
      if (!((seekingMask[i]! >>> gender[j]!) & 1) || !((seekingMask[j]! >>> gender[i]!) & 1))
        return;
      if (age[j]! < ageMin[i]! || age[j]! > ageMax[i]!) return;
      if (age[i]! < ageMin[j]! || age[i]! > ageMax[j]!) return;
    }

    // Takes both answered: at least `minCommonTakes`, with at least one disagreement.
    let common = 0;
    let split = false;
    let takeWeight = 0;
    for (let k = 0; k < takeWords; k++) {
      const agreeI = agreeBits[i * takeWords + k]!;
      const disagreeI = disagreeBits[i * takeWords + k]!;
      const agreeJ = agreeBits[j * takeWords + k]!;
      const disagreeJ = disagreeBits[j * takeWords + k]!;
      let bothAgree = agreeI & agreeJ;
      let bothDisagree = disagreeI & disagreeJ;
      const cross = (agreeI & disagreeJ) | (disagreeI & agreeJ);
      common += popcount(bothAgree) + popcount(bothDisagree) + popcount(cross);
      if (cross !== 0) split = true;
      while (bothAgree !== 0) {
        const low = bothAgree & -bothAgree;
        takeWeight += weights.agree[(k << 5) + 31 - Math.clz32(low)]!;
        bothAgree ^= low;
      }
      while (bothDisagree !== 0) {
        const low = bothDisagree & -bothDisagree;
        takeWeight += weights.disagree[(k << 5) + 31 - Math.clz32(low)]!;
        bothDisagree ^= low;
      }
    }
    if (common < minCommonTakes || !split) return;

    // Shared items, and whether one of them is rare enough for tier 1.
    let itemWeight = 0;
    let niche = false;
    sharedItemCategories.fill(0);
    for (let k = 0; k < itemWords; k++) {
      let shared = itemBits[i * itemWords + k]! & itemBits[j * itemWords + k]!;
      while (shared !== 0) {
        const low = shared & -shared;
        const index = (k << 5) + 31 - Math.clz32(low);
        const weight = weights.item[index]!;
        itemWeight += weight;
        if (weight >= nicheWeight) niche = true;
        const category = universe.itemCategory[index]!;
        sharedItemCategories[category >>> 5]! |= 1 << (category & 31);
        shared ^= low;
      }
    }

    let raw = itemWeight + beta * takeWeight;
    let tier: 0 | Tier = 0;
    if (niche) {
      tier = 1;
    } else {
      // A pair forms at tier t only if both users have relaxed to at least t.
      const allowed = Math.min(relaxed[i]!, relaxed[j]!);
      let anyCommonCategory = false;
      let categoryWeight = 0;
      let commonCategoryDomains = 0;
      for (let k = 0; k < categoryWords; k++) {
        const both = categoryBits[i * categoryWords + k]! & categoryBits[j * categoryWords + k]!;
        if (both === 0) continue;
        anyCommonCategory = true;
        // Partial credit only where they like the same category but share no item in it.
        let credit = both & ~sharedItemCategories[k]!;
        let rest = both;
        while (rest !== 0) {
          const low = rest & -rest;
          commonCategoryDomains |= 1 << universe.categoryDomain[(k << 5) + 31 - Math.clz32(low)]!;
          rest ^= low;
        }
        while (credit !== 0) {
          const low = credit & -credit;
          categoryWeight += weights.category[(k << 5) + 31 - Math.clz32(low)]!;
          credit ^= low;
        }
      }
      if (allowed >= 2 && anyCommonCategory) {
        tier = 2;
        raw += lambdaCategory * categoryWeight;
      } else if (allowed >= 3 && !anyCommonCategory) {
        // Tier 3: the same broad domain, or shared takes alone.
        let domains = domainBits[i]! & domainBits[j]! & ~commonCategoryDomains;
        while (domains !== 0) {
          const low = domains & -domains;
          raw += lambdaDomain * weights.domain[31 - Math.clz32(low)]!;
          domains ^= low;
        }
        if (raw > 0) tier = 3;
      }
    }
    if (tier === 0 || raw <= 0) {
      out.tier = 0;
      return;
    }
    out.tier = tier;
    out.score = (raw / Math.sqrt(mass[i]! * mass[j]!)) * (1 + (gamma * (wait[i]! + wait[j]!)) / 2);
  };

  return { members, candidates, rowOf, profiles, universe, weights, stats, scorePair };
}

/** How one pair would be scored in this run: tier 0 means "not matched". For tests and tooling. */
export function scorePairIn(
  input: PlanInput,
  first: string,
  second: string,
): { tier: 0 | Tier; score: number } | null {
  const { rowOf, scorePair } = prepare(input);
  const a = rowOf.get(first);
  const b = rowOf.get(second);
  if (a === undefined || b === undefined) return null;
  const out: PairScore = { tier: 0, score: 0 };
  scorePair(Math.min(a, b), Math.max(a, b), out);
  return { ...out };
}

export function planPool(input: PlanInput): PlanResult {
  const { members, candidates, profiles, universe, weights, stats, scorePair } = prepare(input);
  const n = candidates.length;
  const { gamma } = input.params;

  // --- Score every pair and pack (tier, score, pair) into one sortable number each. -----------
  // Ascending order of the packed keys is: tier 1 before 2 before 3, then the higher score first,
  // then the seeded candidate order. A double holds 53 bits exactly: 2 for the tier, `pairBits`
  // for the pair and the rest for the score.
  const pairBits = Math.max(1, Math.ceil(Math.log2(Math.max(2, n * n))));
  const scoreLevels = 2 ** (51 - pairBits) - 1;
  const pairSpan = 2 ** pairBits;
  const scoreCap = 1 + gamma; // a normalized score never exceeds 1 before the waiting bonus
  let keys = new Float64Array(1024);
  let keyCount = 0;
  const out: PairScore = { tier: 0, score: 0 };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      scorePair(i, j, out);
      if (out.tier === 0) continue;
      if (keyCount === keys.length) {
        const grown = new Float64Array(keys.length * 2);
        grown.set(keys);
        keys = grown;
      }
      const level = Math.round(Math.min(1, out.score / scoreCap) * scoreLevels);
      keys[keyCount++] =
        (out.tier * (scoreLevels + 1) + (scoreLevels - level)) * pairSpan + (i * n + j);
    }
  }
  const sorted = keys.subarray(0, keyCount).sort();

  // --- Greedy assignment: best pairs first, at most one match per user per run. ----------------
  const taken = new Uint8Array(n);
  const random = prng(input.seed ^ 0x9e3779b9);
  const pairs: PlannedPair[] = [];
  const tierCounts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
  for (let k = 0; k < sorted.length; k++) {
    const pair = sorted[k]! % pairSpan;
    const i = Math.floor(pair / n);
    const j = pair % n;
    if (taken[i]! || taken[j]!) continue;
    taken[i] = 1;
    taken[j] = 1;
    scorePair(i, j, out);
    const tier = out.tier as Tier;
    const [low, high] = candidates[i]!.id < candidates[j]!.id ? [i, j] : [j, i];
    const userA = candidates[low]!;
    const userB = candidates[high]!;
    const { aliasA, aliasB } = pickAliases(
      input.scope.aliases,
      new Set(userA.aliasesInUse),
      new Set(userB.aliasesInUse),
      random,
    );
    tierCounts[tier]++;
    pairs.push({
      userA: userA.id,
      userB: userB.id,
      tier,
      score: out.score,
      teaser: pickTeaser(profiles.get(userA.id)!, profiles.get(userB.id)!, tier, universe, weights),
      aliasA,
      aliasB,
    });
  }

  return { pairs, stats, poolSize: members.length, eligibleUsers: n, tierCounts };
}

/** The highest-weight entry; ties go to the lower ID so the choice is deterministic. */
function heaviest(indexes: readonly number[], weight: Float64Array, ids: readonly string[]) {
  let best: number | undefined;
  for (const index of indexes) {
    if (
      best === undefined ||
      weight[index]! > weight[best]! ||
      (weight[index] === weight[best] && ids[index]! < ids[best]!)
    )
      best = index;
  }
  return best;
}

/**
 * What to tell the two users (PLAN.md §5): the rarest item they share, or, in the fallback tiers,
 * the rarest category or domain they have in common, plus the rarest take they are on the same
 * side of.
 */
function pickTeaser(a: Profile, b: Profile, tier: Tier, u: Universe, weights: Weights): Teaser {
  const both = (x: readonly number[], y: readonly number[]) => {
    const set = new Set(y);
    return x.filter((index) => set.has(index));
  };
  let interest: Teaser['interest'] = null;
  const item = heaviest(both(a.items, b.items), weights.item, u.itemIds);
  if (item !== undefined) {
    interest = { kind: 'item', id: u.itemIds[item]! };
  } else if (tier >= 2) {
    const category = heaviest(both(a.categories, b.categories), weights.category, u.categoryIds);
    const domain = heaviest(both(a.domains, b.domains), weights.domain, u.domainIds);
    if (category !== undefined) interest = { kind: 'category', id: u.categoryIds[category]! };
    else if (tier === 3 && domain !== undefined)
      interest = { kind: 'domain', id: u.domainIds[domain]! };
  }

  const agree = heaviest(both(a.agree, b.agree), weights.agree, u.takeIds);
  const disagree = heaviest(both(a.disagree, b.disagree), weights.disagree, u.takeIds);
  let take: Teaser['take'] = null;
  if (
    agree !== undefined &&
    (disagree === undefined || weights.agree[agree]! >= weights.disagree[disagree]!)
  ) {
    take = { id: u.takeIds[agree]!, value: 'agree' };
  } else if (disagree !== undefined) {
    take = { id: u.takeIds[disagree]!, value: 'disagree' };
  }
  return { interest, take };
}
