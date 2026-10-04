/**
 * Cross-file content checks that schemas alone can't express (docs/content-format.md §7).
 */
import { LOCALES, type Band, type Locale, type Mode } from '@samesync/shared';
import type {
  Alias,
  GenderOption,
  InterestCategory,
  InterestItem,
  LocalizedText,
  Lock,
  Opener,
  Product,
  Question,
  Release,
  Stance,
} from './schema';
import { compareVersions } from './schema';

export interface ContentBundle {
  questions: Question[];
  stances: Stance[];
  categories: InterestCategory[];
  items: InterestItem[];
  genders: GenderOption[];
  openers: Opener[];
  aliases: Alias[];
  products: Product[];
  release: Release | null;
  lock: Lock | null;
}

export interface ContentIssue {
  id: string;
  message: string;
}

/** Length limits, in characters (Unicode code points), so texts fit on cards and chips. */
export const LIMITS = { takeText: 120, stanceText: 80, name: 40, searchTerm: 40 } as const;

/**
 * Launch coverage minimums (Q5, PLAN.md Phase 1). Counted over entries that are not retired.
 * Aliases: a user can have 5 open matches (Q27), each under a different name, with room to spare.
 * Every take also needs its stance and an opener for each side (PLAN.md Phase 3): a teaser can
 * name any take, and a game can end on any take.
 */
export const LAUNCH = {
  takesPerDeck: 35,
  itemsPerLocale: 150,
  domainsPerLocale: 4,
  aliases: 12,
} as const;

/** A match gives its two users different anonymous names, so matching needs at least two. */
export const MIN_ALIASES = 2;

/** The decks users can actually get: `u18` users only ever use friends mode. */
export const DECKS: ReadonlyArray<{ band: Band; mode: Mode }> = [
  { band: 'u18', mode: 'friends' },
  { band: 'adult', mode: 'friends' },
  { band: 'adult', mode: 'dating' },
];

const length = (s: string) => [...s].length;

function missingLocales(text: LocalizedText, required: readonly Locale[]): Locale[] {
  return required.filter((locale) => !text[locale]);
}

export function checkContent(bundle: ContentBundle): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const report = (id: string, message: string) => issues.push({ id, message });

  // Unique IDs across every kind of content.
  const seen = new Set<string>();
  const all = [
    ...bundle.questions,
    ...bundle.stances,
    ...bundle.categories,
    ...bundle.items,
    ...bundle.genders,
    ...bundle.openers,
    ...bundle.aliases,
    ...bundle.products,
  ];
  for (const { id } of all) {
    if (seen.has(id)) report(id, 'duplicate id');
    seen.add(id);
  }

  const requireLocales = (
    id: string,
    field: string,
    text: LocalizedText,
    required: readonly Locale[],
  ) => {
    const missing = missingLocales(text, required);
    if (missing.length > 0) report(id, `${field} is missing locale(s): ${missing.join(', ')}`);
  };
  const limitLength = (id: string, field: string, text: LocalizedText, max: number) => {
    for (const [locale, value] of Object.entries(text)) {
      if (length(value) > max) {
        report(id, `${field}.${locale} is ${length(value)} characters (max ${max})`);
      }
    }
  };

  // Retirement: a version from release.json, never later than the current release.
  const release = bundle.release?.version;
  const checkRetired = (entry: { id: string; retiredIn?: string | undefined }) => {
    if (entry.retiredIn && release && compareVersions(entry.retiredIn, release) > 0) {
      report(entry.id, `retiredIn ${entry.retiredIn} is later than the current release ${release}`);
    }
  };

  const questions = new Map(bundle.questions.map((q) => [q.id, q]));
  const categories = new Map(bundle.categories.map((c) => [c.id, c]));

  for (const q of bundle.questions) {
    requireLocales(q.id, 'text', q.text, q.locales);
    limitLength(q.id, 'text', q.text, LIMITS.takeText);
    checkRetired(q);
    if (q.audiences.includes('u18') && !q.modes.includes('friends')) {
      report(q.id, 'audience u18 needs mode friends (u18 users only use friends mode)');
    }
  }

  // A stance belongs to one take and stays with it, also after the take is retired (matches made
  // before the retirement still show it).
  const stanceOf = new Map<string, string>();
  for (const stance of bundle.stances) {
    const question = questions.get(stance.questionId);
    if (!question) {
      report(stance.id, `references unknown question ${stance.questionId}`);
      continue;
    }
    const other = stanceOf.get(question.id);
    if (other) report(stance.id, `${question.id} already has a stance (${other})`);
    else stanceOf.set(question.id, stance.id);
    for (const side of ['agree', 'disagree'] as const) {
      requireLocales(stance.id, side, stance[side], question.locales);
      limitLength(stance.id, side, stance[side], LIMITS.stanceText);
    }
  }

  for (const c of bundle.categories) {
    requireLocales(c.id, 'name', c.name, c.locales);
    limitLength(c.id, 'name', c.name, LIMITS.name);
    checkRetired(c);
  }

  for (const item of bundle.items) {
    requireLocales(item.id, 'name', item.name, item.locales);
    limitLength(item.id, 'name', item.name, LIMITS.name);
    checkRetired(item);
    for (const [locale, terms] of Object.entries(item.searchTerms ?? {})) {
      if (!item.locales.includes(locale as Locale)) {
        report(item.id, `searchTerms.${locale}: the item is not offered in locale ${locale}`);
      }
      for (const term of terms) {
        if (length(term) > LIMITS.searchTerm) {
          report(
            item.id,
            `searchTerms.${locale}: "${term}" is longer than ${LIMITS.searchTerm} characters`,
          );
        }
      }
    }
    const category = categories.get(item.categoryId);
    if (!category) {
      report(item.id, `references unknown category ${item.categoryId}`);
      continue;
    }
    if (category.retiredIn && !item.retiredIn) {
      report(item.id, `references retired category ${category.id}; retire the item too or move it`);
    }
    if (item.id.split('.')[1] !== category.domain) {
      report(item.id, `id must start with "i.${category.domain}." (the domain of ${category.id})`);
    }
    const extraLocales = item.locales.filter((l) => !category.locales.includes(l));
    if (extraLocales.length > 0) {
      report(item.id, `locale(s) ${extraLocales.join(', ')} not offered by ${category.id}`);
    }
    const extraBands = item.audiences.filter((b) => !category.audiences.includes(b));
    if (extraBands.length > 0) {
      report(item.id, `audience(s) ${extraBands.join(', ')} not offered by ${category.id}`);
    }
  }

  for (const g of bundle.genders) {
    requireLocales(g.id, 'self', g.self, LOCALES);
    requireLocales(g.id, 'seeking', g.seeking, LOCALES);
    limitLength(g.id, 'self', g.self, LIMITS.name);
    limitLength(g.id, 'seeking', g.seeking, LIMITS.name);
    checkRetired(g);
  }
  if (bundle.genders.filter((g) => !g.retiredIn).length < 2) {
    report(
      'dating',
      'needs at least two dating options that are not retired (content/dating/*.json)',
    );
  }

  // Like a stance, an opener stays with its take after the take is retired: a game that started
  // earlier still ends on it, and an ID can never be removed.
  const openerOf = new Map<string, string>();
  for (const opener of bundle.openers) {
    const question = questions.get(opener.questionId);
    if (!question) {
      report(opener.id, `references unknown question ${opener.questionId}`);
      continue;
    }
    const key = `${question.id}:${opener.side}`;
    const other = openerOf.get(key);
    if (other) {
      report(
        opener.id,
        `${question.id} already has an opener for the ${opener.side} side (${other})`,
      );
    } else openerOf.set(key, opener.id);
    requireLocales(opener.id, 'text', opener.text, question.locales);
  }

  for (const alias of bundle.aliases) {
    requireLocales(alias.id, 'text', alias.text, LOCALES);
    limitLength(alias.id, 'text', alias.text, LIMITS.name);
  }
  if (bundle.aliases.length < MIN_ALIASES) {
    report('aliases', `needs at least ${MIN_ALIASES} chat aliases (content/aliases/*.json)`);
  }
  for (const product of bundle.products) {
    requireLocales(product.id, 'title', product.title, LOCALES);
    requireLocales(product.id, 'description', product.description, LOCALES);
  }

  return issues;
}

/** `content:check --launch`: the content is big enough to launch (counts only active entries). */
export function checkLaunchCoverage(bundle: ContentBundle): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const takes = bundle.questions.filter((q) => !q.retiredIn);
  for (const { band, mode } of DECKS) {
    for (const locale of LOCALES) {
      const count = takes.filter(
        (q) => q.audiences.includes(band) && q.modes.includes(mode) && q.locales.includes(locale),
      ).length;
      if (count < LAUNCH.takesPerDeck) {
        issues.push({
          id: `deck ${band}/${mode}/${locale}`,
          message: `has ${count} takes (needs ≥ ${LAUNCH.takesPerDeck})`,
        });
      }
    }
  }
  const withStance = new Set(bundle.stances.map((s) => s.questionId));
  const openerSides = new Set(bundle.openers.map((o) => `${o.questionId}:${o.side}`));
  for (const take of takes) {
    if (!withStance.has(take.id)) {
      issues.push({ id: take.id, message: 'has no stance (content/stances/*.json)' });
    }
    const missing = (['agree', 'disagree'] as const).filter(
      (side) => !openerSides.has(`${take.id}:${side}`),
    );
    if (missing.length > 0) {
      issues.push({
        id: take.id,
        message: `has no opener for the ${missing.join(' and ')} side (content/openers/*.json)`,
      });
    }
  }
  const categories = new Map(bundle.categories.map((c) => [c.id, c]));
  for (const locale of LOCALES) {
    const items = bundle.items.filter((i) => !i.retiredIn && i.locales.includes(locale));
    const domains = new Set(items.map((i) => categories.get(i.categoryId)?.domain));
    if (items.length < LAUNCH.itemsPerLocale || domains.size < LAUNCH.domainsPerLocale) {
      issues.push({
        id: `catalog ${locale}`,
        message: `has ${items.length} items across ${domains.size} domains (needs ≥ ${LAUNCH.itemsPerLocale} items across ≥ ${LAUNCH.domainsPerLocale} domains)`,
      });
    }
  }
  if (bundle.aliases.length < LAUNCH.aliases) {
    issues.push({
      id: 'aliases',
      message: `has ${bundle.aliases.length} chat aliases (needs ≥ ${LAUNCH.aliases})`,
    });
  }
  return issues;
}
