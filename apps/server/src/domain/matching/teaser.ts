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
  /** How each side of a take reads inside a sentence (content/stances). */
  stance(questionId: string): { agree: LocalizedText; disagree: LocalizedText } | undefined;
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

/**
 * One sentence naming what the pair shares: the interest, and the view both hold on a take, in the
 * words of the take's stance ("…also reads Berserk and thinks milk goes in before the cereal").
 * A take without a stance is left out; if nothing can be named, the line is generic.
 */
export function renderTeaser(
  teaser: Teaser,
  locale: Locale,
  content: TeaserContent,
  t: Translator['t'],
): string {
  const sides = teaser.take ? content.stance(teaser.take.id) : undefined;
  const stance = teaser.take && sides ? text(sides[teaser.take.value], locale) : undefined;
  const interest = teaser.interest;
  if (interest?.kind === 'domain') {
    if (content.isDomain(interest.id)) {
      return stance
        ? t(`teaser.domain.${interest.id}.take`, { stance })
        : t(`teaser.domain.${interest.id}`);
    }
  } else if (interest) {
    const entry =
      interest.kind === 'item' ? content.item(interest.id) : content.category(interest.id);
    const name = entry && text(entry.name, locale);
    if (entry && name) {
      return stance
        ? t(`teaser.${interest.kind}.${entry.domain}.take`, { name, stance })
        : t(`teaser.${interest.kind}.${entry.domain}`, { name });
    }
  }
  return stance ? t('teaser.take', { stance }) : t('teaser.generic');
}
