/**
 * Schemas for the versioned content files in /content.
 * Text lives here, never in the DB (PLAN.md §4). Unknown keys are rejected.
 */
import { BANDS, LOCALES, MODES } from '@samesync/shared';
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

export const DOMAINS = ['music', 'games', 'shows', 'movies', 'books', 'memes'] as const;
export const POPULARITY = ['mainstream', 'known', 'niche'] as const;

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

export const Question = z.strictObject({
  id: idWithPrefix('q'),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  modes: uniqueList(Mode),
  /** Expected share of "agree" answers, used as the rarity prior (PLAN.md §5). */
  priorAgree: z.number().gt(0).lt(1),
  text: LocalizedText,
});

export const InterestCategory = z.strictObject({
  id: idWithPrefix('c'),
  domain: z.enum(DOMAINS),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  name: LocalizedText,
});

export const InterestItem = z.strictObject({
  id: idWithPrefix('i'),
  categoryId: idWithPrefix('c'),
  popularity: z.enum(POPULARITY),
  locales: uniqueList(Locale),
  audiences: uniqueList(Band),
  name: LocalizedText,
});

export const Opener = z.strictObject({
  id: idWithPrefix('o'),
  questionId: idWithPrefix('q'),
  /** The side of the person sending the opener. */
  side: z.enum(['agree', 'disagree']),
  text: LocalizedText,
});

export const Alias = z.strictObject({
  id: idWithPrefix('a'),
  emoji: z.string().min(1).max(16),
  text: LocalizedText,
});

export const Product = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/, 'must look like "group.product"'),
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
export const OpenersFile = z.strictObject({ schemaVersion, openers: z.array(Opener) });
export const AliasesFile = z.strictObject({ schemaVersion, aliases: z.array(Alias) });
export const ProductsFile = z.strictObject({ schemaVersion, products: z.array(Product) });

export type Question = z.infer<typeof Question>;
export type InterestCategory = z.infer<typeof InterestCategory>;
export type InterestItem = z.infer<typeof InterestItem>;
export type Opener = z.infer<typeof Opener>;
export type Alias = z.infer<typeof Alias>;
export type Product = z.infer<typeof Product>;
