import { LOCALES } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import { describe, expect, it } from 'vitest';
import { realContent } from '../../../test/support/app';
import type { Stance } from '../matching/types';
import { renderOpener, type OpenerContent } from './opener';

const SIDES: readonly Stance[] = ['agree', 'disagree'];

/** Three takes; only the first has openers, and only its "agree" one exists in English. */
const content: OpenerContent = {
  question: (id) =>
    ({
      'q.pizza': {
        text: { ru: 'Ананасы на пицце — это нормально', en: 'Pineapple on pizza is fine' },
      },
      'q.cats': { text: { ru: 'Кошки лучше собак', en: 'Cats are better than dogs' } },
      'q.ru_only': { text: { ru: 'Только по-русски' } },
    })[id],
  opener: (id, side) =>
    id === 'q.pizza'
      ? side === 'agree'
        ? { ru: 'Я за ананасы. Что с ними не так?', en: "I'm pro-pineapple. What's wrong with it?" }
        : { ru: 'Ананасам на пицце не место. Чем они тебе нравятся?' }
      : undefined,
};

describe('renderOpener', () => {
  it('uses the authored opener of the sender side, in the given locale', () => {
    const closing = { questionId: 'q.pizza', side: 'agree' } as const;
    expect(renderOpener(closing, content, translatorFor('ru'))).toBe(
      'Я за ананасы. Что с ними не так?',
    );
    expect(renderOpener(closing, content, translatorFor('en'))).toBe(
      "I'm pro-pineapple. What's wrong with it?",
    );
    expect(
      renderOpener({ questionId: 'q.pizza', side: 'disagree' }, content, translatorFor('ru')),
    ).toBe('Ананасам на пицце не место. Чем они тебе нравятся?');
  });

  it('falls back to a message built from the statement when the opener is missing', () => {
    expect(
      renderOpener({ questionId: 'q.cats', side: 'agree' }, content, translatorFor('ru')),
    ).toBe('«Кошки лучше собак» — я за. А ты почему против?');
    expect(
      renderOpener({ questionId: 'q.cats', side: 'disagree' }, content, translatorFor('en')),
    ).toBe('“Cats are better than dogs” — I disagree. Why do you agree?');
    // An opener that exists only in another locale is not shown in the wrong language.
    expect(
      renderOpener({ questionId: 'q.pizza', side: 'disagree' }, content, translatorFor('en')),
    ).toBe('“Pineapple on pizza is fine” — I disagree. Why do you agree?');
    // A statement that exists only in Russian is quoted as it is.
    expect(
      renderOpener({ questionId: 'q.ru_only', side: 'agree' }, content, translatorFor('en')),
    ).toBe("“Только по-русски” — I agree. Why don't you?");
  });

  it('stays generic for a take it knows nothing about', () => {
    expect(
      renderOpener({ questionId: 'q.gone', side: 'agree' }, content, translatorFor('ru')),
    ).toBe('Мы разошлись в одном ответе. Расскажешь, почему?');
  });

  it('contains nothing beyond the closing question: it never looks at another take', () => {
    const asked = new Set<string>();
    const spy: OpenerContent = {
      question: (id) => (asked.add(id), content.question(id)),
      opener: (id, side) => (asked.add(id), content.opener(id, side)),
    };
    for (const locale of LOCALES) {
      for (const side of SIDES) {
        const text = renderOpener({ questionId: 'q.cats', side }, spy, translatorFor(locale));
        expect(text).not.toMatch(/пицц|pizza|Только/i);
      }
    }
    expect(asked).toEqual(new Set(['q.cats']));
  });
});

describe('openers of the committed content', () => {
  it('render for every take, side and locale, with no placeholder left and no fallback needed', async () => {
    const store = await realContent();
    const takes = new Set<string>();
    for (const scope of [
      { band: 'u18', mode: 'friends' },
      { band: 'adult', mode: 'friends' },
      { band: 'adult', mode: 'dating' },
    ] as const) {
      for (const locale of LOCALES) {
        for (const question of store.deckCandidates({ ...scope, locale })) takes.add(question.id);
      }
    }
    expect(takes.size).toBeGreaterThanOrEqual(35);
    for (const questionId of takes) {
      for (const side of SIDES) {
        for (const locale of LOCALES) {
          const text = renderOpener({ questionId, side }, store.game, translatorFor(locale));
          const authored = store.game.opener(questionId, side)?.[locale];
          expect({ questionId, side, locale, text }).toEqual({
            questionId,
            side,
            locale,
            text: authored,
          });
          expect(text.trim().length).toBeGreaterThan(10);
          expect(text).not.toMatch(/[{}]|game\.opener/);
        }
      }
    }
  });

  it('gives the two sides of a take different openers', async () => {
    const store = await realContent();
    const agree = store.game.opener('q.pineapple_pizza', 'agree');
    const disagree = store.game.opener('q.pineapple_pizza', 'disagree');
    expect(agree?.ru).toBe('Я за ананасы на пицце. Что с ними не так?');
    expect(disagree?.en).toBe("Pineapple doesn't belong on pizza. What do you like about it?");
  });
});
