import { DOMAINS, type Domain } from '@samesync/content';
import { LOCALES } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import { describe, expect, it } from 'vitest';
import { realContent } from '../../../test/support/app';
import { HOUR, NOW, answers, candidate, planInput } from '../../../test/support/matching';
import { planPool } from './plan';
import { parseTeaser, renderTeaser, type TeaserContent } from './teaser';
import type { MatchCandidate, Teaser } from './types';

const waited = (hours: number, over: Partial<MatchCandidate>) =>
  candidate({ waitingSince: NOW - hours * HOUR, ...over });
const teaserOf = (users: MatchCandidate[]) => planPool(planInput(users)).pairs[0];

describe('teaser selection', () => {
  it('names the rarest shared item and the rarest take both are on the same side of', () => {
    // Shared: a niche and a mainstream item; takes t01–t04 (even) and t12 agree (a 10% view).
    const a = candidate({
      items: ['i.music.star', 'i.music.niche_a'],
      answers: answers('AAAAD------A'),
    });
    const b = candidate({
      items: ['i.music.niche_a', 'i.music.star'],
      answers: answers('AAAAA------A'),
    });
    expect(teaserOf([a, b])).toMatchObject({
      tier: 1,
      teaser: {
        interest: { kind: 'item', id: 'i.music.niche_a' },
        take: { id: 'q.t12', value: 'agree' },
      },
    });
  });

  it('can name a take both disagree with', () => {
    // Disagreeing with t11 (90% agree) is the rare side.
    const a = candidate({ items: ['i.music.niche_a'], answers: answers('AAAAD-----D-') });
    const b = candidate({ items: ['i.music.niche_a'], answers: answers('AAAAA-----D-') });
    expect(teaserOf([a, b])?.teaser.take).toEqual({ id: 'q.t11', value: 'disagree' });
  });

  it('names a shared item at tier 2 when there is one, else the common category', () => {
    const shared = [
      waited(30, { items: ['i.music.star'] }),
      waited(30, { items: ['i.music.star'], answers: answers('AAAAAA') }),
    ];
    expect(teaserOf(shared)).toMatchObject({
      tier: 2,
      teaser: { interest: { kind: 'item', id: 'i.music.star' } },
    });
    const related = [
      waited(30, { items: ['i.games.indie_a'] }),
      waited(30, { items: ['i.games.indie_b'], answers: answers('AAAAAA') }),
    ];
    expect(teaserOf(related)).toMatchObject({
      tier: 2,
      teaser: { interest: { kind: 'category', id: 'c.games.indie' } },
    });
  });

  it('names the common domain at tier 3, or only the take when nothing else is shared', () => {
    const broad = [
      waited(100, { items: ['i.games.indie_a'] }),
      waited(100, { items: ['i.games.shooter'], answers: answers('AAAAAA') }),
    ];
    expect(teaserOf(broad)).toMatchObject({
      tier: 3,
      teaser: { interest: { kind: 'domain', id: 'games' }, take: { value: 'agree' } },
    });
    const takesOnly = [
      waited(100, { items: ['i.games.indie_a'] }),
      waited(100, { items: ['i.music.star'], answers: answers('AAAAAA') }),
    ];
    expect(teaserOf(takesOnly)).toMatchObject({
      tier: 3,
      teaser: { interest: null, take: { id: 'q.t01', value: 'agree' } },
    });
  });

  it('leaves the take out when the two agree on nothing', () => {
    const a = candidate({ items: ['i.music.niche_a'], answers: answers('AAAAA') });
    const b = candidate({ items: ['i.music.niche_a'], answers: answers('DDDDD') });
    expect(teaserOf([a, b])?.teaser).toEqual({
      interest: { kind: 'item', id: 'i.music.niche_a' },
      take: null,
    });
  });
});

describe('teaser rendering', () => {
  /** Fake content: one item and one category per domain, and the stance of one take. */
  const content: TeaserContent = {
    item: (id) => {
      const domain = id.split('.')[1] as Domain;
      return id.startsWith('i.') && DOMAINS.includes(domain)
        ? { domain, name: { ru: `Предмет-${domain}`, en: `Item-${domain}` } }
        : undefined;
    },
    category: (id) => {
      const domain = id.split('.')[1] as Domain;
      return id.startsWith('c.') && DOMAINS.includes(domain)
        ? { domain, name: { ru: `Категория-${domain}`, en: `Category-${domain}` } }
        : undefined;
    },
    stance: (id) =>
      id === 'q.pizza'
        ? {
            agree: { ru: 'ананасы на пицце — это нормально', en: 'pineapple on pizza is fine' },
            disagree: { ru: 'ананасам не место на пицце', en: "pineapple doesn't belong on pizza" },
          }
        : undefined,
    isDomain: (id): id is Domain => (DOMAINS as readonly string[]).includes(id),
  };
  const render = (teaser: Teaser, locale: 'ru' | 'en') =>
    renderTeaser(teaser, locale, content, translatorFor(locale).t);
  const take = { id: 'q.pizza', value: 'agree' } as const;

  it('has a template for every kind of overlap (tier) and every domain, with and without a take, in ru and en', () => {
    for (const locale of LOCALES) {
      const seen = new Set<string>();
      const stance = locale === 'ru' ? 'ананасы на пицце — это нормально' : 'pineapple on pizza';
      for (const domain of DOMAINS) {
        for (const shared of [null, take]) {
          const item = render(
            { interest: { kind: 'item', id: `i.${domain}.x` }, take: shared },
            locale,
          );
          const category = render(
            { interest: { kind: 'category', id: `c.${domain}.x` }, take: shared },
            locale,
          );
          const whole = render({ interest: { kind: 'domain', id: domain }, take: shared }, locale);
          expect(item).toContain(locale === 'ru' ? `Предмет-${domain}` : `Item-${domain}`);
          expect(category).toContain(
            locale === 'ru' ? `Категория-${domain}` : `Category-${domain}`,
          );
          for (const text of [item, category, whole]) {
            // A missing key would come back as the key itself; a missing param as "{name}".
            expect(text).not.toMatch(/teaser\.|[{}]/);
            expect(text.includes(stance)).toBe(shared !== null);
            // One sentence: the only full stop is the last character.
            expect(text.indexOf('.')).toBe(text.length - 1);
            seen.add(text);
          }
        }
      }
      // Items and categories may share their wording; domains never name anything.
      expect(seen.size).toBeGreaterThanOrEqual(DOMAINS.length * 2 * 2);
    }
  });

  it('renders the item and the shared view in the reader language, as one sentence', () => {
    const teaser: Teaser = { interest: { kind: 'item', id: 'i.music.x' }, take };
    expect(render(teaser, 'ru')).toBe(
      'У кого-то здесь в плейлисте тоже Предмет-music — и такое же мнение: ананасы на пицце — это нормально.',
    );
    expect(render(teaser, 'en')).toBe(
      'Someone here also listens to Item-music and thinks pineapple on pizza is fine.',
    );
    expect(render({ interest: { kind: 'domain', id: 'games' }, take }, 'ru')).toBe(
      'Кто-то здесь тоже любит игры и считает, что ананасы на пицце — это нормально.',
    );
  });

  it('uses the stance of the side both are on, and names the view alone when nothing else is shared', () => {
    const against: Teaser = { interest: null, take: { ...take, value: 'disagree' } };
    expect(render(against, 'ru')).toBe(
      'Кто-то здесь тоже считает, что ананасам не место на пицце.',
    );
    expect(render(against, 'en')).toBe(
      "Someone here also thinks pineapple doesn't belong on pizza.",
    );
  });

  it('leaves out a take that has no stance, and falls back to a generic line when nothing can be named', () => {
    const noStance = { id: 'q.gone', value: 'agree' } as const;
    expect(render({ interest: { kind: 'item', id: 'i.books.x' }, take: noStance }, 'ru')).toBe(
      'У кого-то здесь на книжной полке тоже Предмет-books.',
    );
    expect(render({ interest: { kind: 'item', id: 'x.unknown' }, take: null }, 'ru')).toBe(
      'Кто-то с похожими вкусами уже здесь.',
    );
    expect(render({ interest: null, take: noStance }, 'en')).toBe(
      'Someone with similar tastes is already here.',
    );
    expect(render({ interest: { kind: 'domain', id: 'cooking' }, take: null }, 'en')).toBe(
      'Someone with similar tastes is already here.',
    );
  });

  it('reads a stored teaser and tolerates anything unexpected', () => {
    const stored = { interest: { kind: 'category', id: 'c.music.x' }, take: null };
    expect(parseTeaser(stored)).toEqual(stored);
    for (const bad of [null, 'text', {}, { interest: { kind: 'user', id: '1' }, take: null }]) {
      expect(parseTeaser(bad)).toEqual({ interest: null, take: null });
    }
  });
});

describe('teasers of the committed content', () => {
  it('reads as in the product brief: an item in its dictionary form and a stance', async () => {
    const { teaser: content } = await realContent();
    const teaser: Teaser = {
      interest: { kind: 'item', id: 'i.books.berserk' },
      take: { id: 'q.milk_before_cereal', value: 'agree' },
    };
    expect(renderTeaser(teaser, 'en', content, translatorFor('en').t)).toBe(
      'Someone here also reads Berserk and thinks milk goes in before the cereal.',
    );
    // Russian keeps the name in the nominative, whatever its declension would be.
    expect(renderTeaser(teaser, 'ru', content, translatorFor('ru').t)).toBe(
      'У кого-то здесь на книжной полке тоже Берсерк — и такое же мнение: молоко наливают раньше хлопьев.',
    );
    const author: Teaser = {
      interest: { kind: 'item', id: 'i.books.dostoevsky' },
      take: { id: 'q.milk_before_cereal', value: 'disagree' },
    };
    expect(renderTeaser(author, 'ru', content, translatorFor('ru').t)).toBe(
      'У кого-то здесь на книжной полке тоже Достоевский — и такое же мнение: сначала хлопья, потом молоко.',
    );
  });

  it('can name either side of every take of every deck, in ru and en', async () => {
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
    const generic = new Set(LOCALES.map((locale) => translatorFor(locale).t('teaser.generic')));
    for (const id of takes) {
      for (const value of ['agree', 'disagree'] as const) {
        for (const locale of LOCALES) {
          const text = renderTeaser(
            { interest: null, take: { id, value } },
            locale,
            store.teaser,
            translatorFor(locale).t,
          );
          expect({ id, value, locale, generic: generic.has(text) }).toEqual({
            id,
            value,
            locale,
            generic: false,
          });
          expect(text).not.toMatch(/[{}]/);
        }
      }
    }
  });
});
