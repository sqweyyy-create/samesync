/**
 * Turning a stored teaser (content IDs only, PLAN.md §5) into text for one reader. Rendering
 * happens at read or send time, in that reader's locale, so nothing rendered is ever stored.
 */
import type { Domain, LocalizedText } from '@samesync/content';
import type { Locale } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { z } from 'zod';
import type { Teaser } from './types';

/** The content lookups rendering needs. Retired entries still resolve: old matches keep their text. */
export interface TeaserContent {
  item(id: string): { name: LocalizedText; domain: Domain } | undefined;
  category(id: string): { name: LocalizedText; domain: Domain } | undefined;
  question(id: string): { text: LocalizedText } | undefined;
  isDomain(id: string): id is Domain;
}

const TeaserSchema = z.object({
  interest: z.object({ kind: z.enum(['item', 'category', 'domain']), id: z.string() }).nullable(),
  take: z.object({ id: z.string(), value: z.enum(['agree', 'disagree']) }).nullable(),
});

/** Reads `matches.teaser`; anything unexpected becomes an empty teaser (rendered generically). */
export function parseTeaser(value: unknown): Teaser {
  const parsed = TeaserSchema.safeParse(value);
  return parsed.success ? parsed.data : { interest: null, take: null };
}

const text = (value: LocalizedText, locale: Locale) => value[locale] ?? value.ru ?? value.en;

/** One or two sentences naming what the pair shares; a generic line if nothing can be named. */
export function renderTeaser(
  teaser: Teaser,
  locale: Locale,
  content: TeaserContent,
  t: Translator['t'],
): string {
  const parts: string[] = [];
  const interest = teaser.interest;
  if (interest?.kind === 'domain') {
    if (content.isDomain(interest.id)) parts.push(t(`teaser.domain.${interest.id}`));
  } else if (interest) {
    const entry =
      interest.kind === 'item' ? content.item(interest.id) : content.category(interest.id);
    const name = entry && text(entry.name, locale);
    if (entry && name) parts.push(t(`teaser.${interest.kind}.${entry.domain}`, { name }));
  }
  if (teaser.take) {
    const statement = content.question(teaser.take.id);
    const body = statement && text(statement.text, locale);
    if (body) parts.push(t(`teaser.take.${teaser.take.value}`, { text: body }));
  }
  return parts.length > 0 ? parts.join(' ') : t('teaser.generic');
}
