/**
 * The suggested first message (PLAN.md Phase 3, Q4): a template from content/openers, written
 * from the sender's side of the take the game ended on. It is about that one take and nothing
 * else. A take without an opener for that side gets a plain message built from its statement.
 */
import type { LocalizedText } from '@samesync/content';
import type { Translator } from '@samesync/shared/i18n';
import type { Stance } from '../matching/types';

/** The content lookups an opener needs. Retired takes still resolve: a game in flight keeps its text. */
export interface OpenerContent {
  opener(questionId: string, side: Stance): LocalizedText | undefined;
  question(questionId: string): { text: LocalizedText } | undefined;
}

/**
 * The opener for the person on `side` of the closing question, in the translator's locale. That
 * is the match's locale, not the reader's: the message is meant for the other person.
 */
export function renderOpener(
  closing: { questionId: string; side: Stance },
  content: OpenerContent,
  translator: Pick<Translator, 'locale' | 't'>,
): string {
  const { locale, t } = translator;
  const authored = content.opener(closing.questionId, closing.side)?.[locale];
  if (authored) return authored;
  const statement = content.question(closing.questionId)?.text;
  const text = statement?.[locale] ?? statement?.ru ?? statement?.en;
  return text ? t(`game.opener.fallback.${closing.side}`, { text }) : t('game.opener.generic');
}
