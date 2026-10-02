/**
 * Cross-file content checks that schemas alone can't express.
 * Phase 0 scope: unique IDs, every locale present, valid references.
 * The text lockfile / revision-bump check arrives in Phase 1 (PLAN.md).
 */
import { LOCALES, type Locale } from '@samesync/shared';
import type {
  Alias,
  InterestCategory,
  InterestItem,
  LocalizedText,
  Opener,
  Product,
  Question,
} from './schema';

export interface ContentBundle {
  questions: Question[];
  categories: InterestCategory[];
  items: InterestItem[];
  openers: Opener[];
  aliases: Alias[];
  products: Product[];
}

export interface ContentIssue {
  id: string;
  message: string;
}

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
    ...bundle.categories,
    ...bundle.items,
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

  const questions = new Map(bundle.questions.map((q) => [q.id, q]));
  const categories = new Map(bundle.categories.map((c) => [c.id, c]));

  for (const q of bundle.questions) requireLocales(q.id, 'text', q.text, q.locales);
  for (const c of bundle.categories) requireLocales(c.id, 'name', c.name, c.locales);

  for (const item of bundle.items) {
    requireLocales(item.id, 'name', item.name, item.locales);
    const category = categories.get(item.categoryId);
    if (!category) {
      report(item.id, `references unknown category ${item.categoryId}`);
      continue;
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

  for (const opener of bundle.openers) {
    const question = questions.get(opener.questionId);
    if (!question) {
      report(opener.id, `references unknown question ${opener.questionId}`);
      continue;
    }
    requireLocales(opener.id, 'text', opener.text, question.locales);
  }

  for (const alias of bundle.aliases) requireLocales(alias.id, 'text', alias.text, LOCALES);
  for (const product of bundle.products) {
    requireLocales(product.id, 'title', product.title, LOCALES);
    requireLocales(product.id, 'description', product.description, LOCALES);
  }

  return issues;
}
