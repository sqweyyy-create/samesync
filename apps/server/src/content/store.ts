/**
 * Read-only view of the validated content files, used to build decks, list interests and render
 * texts. IDs, metadata and the release are also seeded into the DB (seed.ts) for integrity.
 */
import {
  DOMAINS,
  type Alias,
  type ContentBundle,
  type Domain,
  type GenderOption,
  type InterestCategory,
  type InterestItem,
  type LocalizedText,
  type Question,
} from '@samesync/content';
import type { Band, Locale, Mode } from '@samesync/shared';
import type { TeaserContent } from '../domain/matching/teaser';
import type { PoolScope } from '../domain/matching/types';

export interface DeckScope {
  band: Band;
  mode: Mode;
  locale: Locale;
}

export interface CatalogScope {
  band: Band;
  locale: Locale;
}

export interface CatalogEntry {
  item: InterestItem;
  category: InterestCategory;
}

export interface ContentStore {
  readonly release: string;
  readonly checksum: string;
  /** Active takes a user in this scope may see, ordered by ID. */
  deckCandidates(scope: DeckScope): Question[];
  isQuestionAvailable(id: string, scope: DeckScope): boolean;
  /** Active items (in active categories) a user in this scope may pick, ordered by ID. */
  catalog(scope: CatalogScope): CatalogEntry[];
  isItemAvailable(id: string, scope: CatalogScope): boolean;
  searchCatalog(scope: CatalogScope, filter: { domain?: Domain; q?: string }): CatalogEntry[];
  datingOptions(): GenderOption[];
  isDatingOption(id: string): boolean;
  /** The catalog, deck and aliases of one pool × mode, as a matching run needs them. */
  matchScope(scope: DeckScope): PoolScope;
  /** Lookups for rendering teasers. Retired entries still resolve, so old matches keep their text. */
  readonly teaser: TeaserContent;
  alias(id: string): Alias | undefined;
}

/** Lower-case, ё → е, and no diacritics, so "Ёлка" matches "елка" and "Beyoncé" matches "beyonce". */
export function normalizeSearch(value: string): string {
  return value
    .toLocaleLowerCase('ru')
    .replaceAll('ё', 'е')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .trim();
}

export function localized(text: LocalizedText, locale: Locale): string {
  return text[locale] ?? text.ru ?? text.en ?? '';
}

export function createContentStore(bundle: ContentBundle, checksum: string): ContentStore {
  if (!bundle.release) throw new Error('content has no release.json');
  const byId = <T extends { id: string }>(list: T[]) =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  const questions = byId(bundle.questions.filter((q) => !q.retiredIn));
  const categories = new Map(bundle.categories.filter((c) => !c.retiredIn).map((c) => [c.id, c]));
  const items = byId(bundle.items.filter((i) => !i.retiredIn && categories.has(i.categoryId)));
  const genders = byId(bundle.genders.filter((g) => !g.retiredIn));
  const aliases = new Map(bundle.aliases.map((a) => [a.id, a]));
  if (aliases.size < 2) throw new Error('content needs at least two chat aliases');
  // Everything ever published, for rendering what existing matches refer to.
  const allCategories = new Map(bundle.categories.map((c) => [c.id, c]));
  const allItems = new Map(bundle.items.map((i) => [i.id, i]));
  const stances = new Map(bundle.stances.map((s) => [s.questionId, s]));

  const inDeck = (q: Question, s: DeckScope) =>
    q.audiences.includes(s.band) && q.modes.includes(s.mode) && q.locales.includes(s.locale);
  const inCatalog = (i: InterestItem, s: CatalogScope) =>
    i.audiences.includes(s.band) && i.locales.includes(s.locale);
  const catalog = (s: CatalogScope): CatalogEntry[] =>
    items
      .filter((i) => inCatalog(i, s))
      .map((item) => ({ item, category: categories.get(item.categoryId)! }));

  return {
    release: bundle.release.version,
    checksum,
    deckCandidates: (scope) => questions.filter((q) => inDeck(q, scope)),
    isQuestionAvailable: (id, scope) => questions.some((q) => q.id === id && inDeck(q, scope)),
    catalog,
    isItemAvailable: (id, scope) => items.some((i) => i.id === id && inCatalog(i, scope)),
    searchCatalog(scope, { domain, q }) {
      const needle = q ? normalizeSearch(q) : '';
      return catalog(scope).filter(({ item, category }) => {
        if (domain && category.domain !== domain) return false;
        if (!needle) return true;
        const haystack = [
          ...Object.values(item.name),
          localized(category.name, scope.locale),
          ...(item.searchTerms?.[scope.locale] ?? []),
        ];
        return haystack.some((text) => normalizeSearch(text).includes(needle));
      });
    },
    datingOptions: () => genders,
    isDatingOption: (id) => genders.some((g) => g.id === id),
    matchScope: (scope) => ({
      items: catalog(scope).map(({ item, category }) => ({
        id: item.id,
        categoryId: category.id,
        domain: category.domain,
        popularity: item.popularity,
      })),
      takes: questions
        .filter((q) => inDeck(q, scope))
        .map((q) => ({ id: q.id, priorAgree: q.priorAgree })),
      aliases: [...aliases.keys()].sort(),
    }),
    teaser: {
      item(id) {
        const item = allItems.get(id);
        const category = item && allCategories.get(item.categoryId);
        return item && category ? { name: item.name, domain: category.domain } : undefined;
      },
      category(id) {
        const category = allCategories.get(id);
        return category ? { name: category.name, domain: category.domain } : undefined;
      },
      stance: (questionId) => stances.get(questionId),
      isDomain: (id): id is Domain => (DOMAINS as readonly string[]).includes(id),
    },
    alias: (id) => aliases.get(id),
  };
}
