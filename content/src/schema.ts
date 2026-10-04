/**
 * Schemas for the versioned content files in /content (reference: docs/content-format.md).
 * Text lives here, never in the DB (PLAN.md §4). Unknown keys are rejected.
 * Fields added in Phase 1 (`revision`, `retiredIn`, `searchTerms`) are optional with defaults, so
 * files written before Phase 1 stay valid. Phase 3 added the stances file type.
 */
import { BANDS, LOCALES, MODES } from '@samesync/shared';
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const DOMAINS = ['music', 'games', 'shows', 'movies', 'books', 'memes'] as const;
export type Domain = (typeof DOMAINS)[number];
export const POPULARITY = ['mainstream', 'known', 'niche'] as const;
export type Popularity = (typeof POPULARITY)[number];

/** Release versions look like `2026.10.1`: year, month, then a counter within the month. */
export const RELEASE_VERSION = /^(\d{4})\.(0[1-9]|1[0-2])\.(\d+)$/;

const Locale = z.enum(LOCALES);
const Band = z.enum(BANDS);
const Mode = z.enum(MODES);

/** A text in some locales. Which locales are required is checked in check.ts. */
export const LocalizedText = z.partialRecord(Locale, z.string().trim().min(1));
export type LocalizedText = z.infer<typeof LocalizedText>;

function uniqueList<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .min(1)
    .refine((list) => new Set(list).size === list.length, 'must not contain duplicates');
}

function idWithPrefix(prefix: string) {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}\\.[a-z0-9_]+(\\.[a-z0-9_]+)*$`),
      `must look like "${prefix}.some_slug"`,
    );
}

/** Bumped whenever a text of the entry changes (enforced by content.lock.json). */
const revision = z.int().min(1).default(1);
/** The release (from release.json) in which the entry was retired. */
const retiredIn = z.string().regex(RELEASE_VERSION, 'must be a release version like "2026.10.1"');

export const Question = z.strictObject({
  id: idWithPrefix('q'),
  revision,
  retiredIn: retiredIn.optional(),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  modes: uniqueList(Mode),
  /** Expected share of "agree" answers, used as the rarity prior (PLAN.md §5). */
  priorAgree: z.number().gt(0).lt(1),
  text: LocalizedText,
});

export const InterestCategory = z.strictObject({
  id: idWithPrefix('c'),
  revision,
  retiredIn: retiredIn.optional(),
  domain: z.enum(DOMAINS),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  name: LocalizedText,
});

const SearchTerms = z.partialRecord(Locale, z.array(z.string().trim().min(1)).max(10));

export const InterestItem = z.strictObject({
  id: idWithPrefix('i'),
  revision,
  retiredIn: retiredIn.optional(),
  categoryId: idWithPrefix('c'),
  popularity: z.enum(POPULARITY),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  name: LocalizedText,
  /** Extra words the interest picker's search matches, per locale. Never shown. */
  searchTerms: SearchTerms.optional(),
});

export const GenderOption = z.strictObject({
  id: idWithPrefix('g'),
  revision,
  retiredIn: retiredIn.optional(),
  /** Label in the "You are" list. */
  self: LocalizedText,
  /** Label in the "Looking for" list. */
  seeking: LocalizedText,
});

/**
 * How each side of a take reads inside a sentence ("…thinks pineapple on pizza is fine"). One per
 * take; it stays with the take, also after the take is retired.
 */
export const Stance = z.strictObject({
  id: idWithPrefix('s'),
  revision,
  questionId: idWithPrefix('q'),
  agree: LocalizedText,
  disagree: LocalizedText,
});

export const Opener = z.strictObject({
  id: idWithPrefix('o'),
  revision,
  questionId: idWithPrefix('q'),
  /** The side of the person sending the opener. */
  side: z.enum(['agree', 'disagree']),
  text: LocalizedText,
});

export const Alias = z.strictObject({
  id: idWithPrefix('a'),
  revision,
  emoji: z.string().min(1).max(16),
  text: LocalizedText,
});

export const Product = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'must look like "group.product"'),
  revision,
  stars: z.int().positive(),
  enabled: z.boolean(),
  bandsAllowed: z.array(Band).refine((l) => new Set(l).size === l.length, 'must not repeat'),
  grants: z.array(z.strictObject({ kind: z.string().min(1), amount: z.int().positive() })).min(1),
  title: LocalizedText,
  description: LocalizedText,
});

const schemaVersion = z.literal(SCHEMA_VERSION);

export const QuestionsFile = z.strictObject({ schemaVersion, questions: z.array(Question) });
export const InterestsFile = z.strictObject({
  schemaVersion,
  categories: z.array(InterestCategory),
  items: z.array(InterestItem),
});
export const GendersFile = z.strictObject({ schemaVersion, genders: z.array(GenderOption) });
export const StancesFile = z.strictObject({ schemaVersion, stances: z.array(Stance) });
export const OpenersFile = z.strictObject({ schemaVersion, openers: z.array(Opener) });
export const AliasesFile = z.strictObject({ schemaVersion, aliases: z.array(Alias) });
export const ProductsFile = z.strictObject({ schemaVersion, products: z.array(Product) });
export const ReleaseFile = z.strictObject({
  schemaVersion,
  version: z.string().regex(RELEASE_VERSION, 'must be a release version like "2026.10.1"'),
});

/** content.lock.json: the revision and text hash of every content entry that has text. */
export const LockFile = z.strictObject({
  schemaVersion,
  entries: z.record(
    z.string(),
    z.strictObject({ revision: z.int().min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
  ),
});

export type Question = z.infer<typeof Question>;
export type InterestCategory = z.infer<typeof InterestCategory>;
export type InterestItem = z.infer<typeof InterestItem>;
export type GenderOption = z.infer<typeof GenderOption>;
export type Stance = z.infer<typeof Stance>;
export type Opener = z.infer<typeof Opener>;
export type Alias = z.infer<typeof Alias>;
export type Product = z.infer<typeof Product>;
export type Release = z.infer<typeof ReleaseFile>;
export type Lock = z.infer<typeof LockFile>;

/** Compares two release versions; negative if a < b. */
export function compareVersions(a: string, b: string): number {
  const pa = RELEASE_VERSION.exec(a);
  const pb = RELEASE_VERSION.exec(b);
  if (!pa || !pb) throw new Error(`not a release version: ${pa ? b : a}`);
  for (const i of [1, 2, 3]) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}
