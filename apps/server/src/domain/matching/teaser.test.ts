import { DOMAINS, type Domain } from '@samesync/content';
import { LOCALES } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import { describe, expect, it } from 'vitest';
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
  /** Fake content: one item and one category per domain, and one take. */
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
    question: (id) =>
      id === 'q.pizza'
        ? { text: { ru: 'Ананасы на пицце — это нормально', en: 'Pineapple on pizza is fine' } }
        : undefined,
    isDomain: (id): id is Domain => (DOMAINS as readonly string[]).includes(id),
  };
  const render = (teaser: Teaser, locale: 'ru' | 'en') =>
    renderTeaser(teaser, locale, content, translatorFor(locale).t);
  const take = { id: 'q.pizza', value: 'agree' } as const;

  it('has a template for every kind of overlap (tier) and every domain, in ru and en', () => {
    for (const locale of LOCALES) {
      const seen = new Set<string>();
      for (const domain of DOMAINS) {
        const item = render(
          { interest: { kind: 'item', id: `i.${domain}.x` }, take: null },
          locale,
        );
        const category = render(
          { interest: { kind: 'category', id: `c.${domain}.x` }, take: null },
          locale,
        );
        const whole = render({ interest: { kind: 'domain', id: domain }, take: null }, locale);
        expect(item).toContain(locale === 'ru' ? `Предмет-${domain}` : `Item-${domain}`);
        expect(category).toContain(locale === 'ru' ? `Категория-${domain}` : `Category-${domain}`);
        for (const text of [item, category, whole]) {
          // A missing key would come back as the key itself; a missing param as "{name}".
          expect(text).not.toMatch(/teaser\.|[{}]/);
          seen.add(text);
        }
      }
      expect(seen.size).toBeGreaterThanOrEqual(DOMAINS.length * 2 + 4);
    }
  });

  it('renders the item and the take in the reader language', () => {
    const teaser: Teaser = { interest: { kind: 'item', id: 'i.music.x' }, take };
    expect(render(teaser, 'ru')).toBe(
      'У кого-то в плейлисте тоже Предмет-music. Вы сходитесь во мнении: «Ананасы на пицце — это нормально» — вы за.',
    );
    expect(render(teaser, 'en')).toBe(
      'Someone here also listens to Item-music. You see it the same way: “Pineapple on pizza is fine” — you both agree.',
    );
    expect(render({ interest: null, take: { ...take, value: 'disagree' } }, 'ru')).toBe(
      'Вы сходитесь во мнении: «Ананасы на пицце — это нормально» — вы против.',
    );
  });

  it('falls back to a generic line when nothing can be named', () => {
    const unknown: Teaser = {
      interest: { kind: 'item', id: 'i.music' },
      take: { id: 'q.gone', value: 'agree' },
    };
    expect(render({ interest: { kind: 'item', id: 'x.unknown' }, take: null }, 'ru')).toBe(
      'Кто-то с похожими вкусами уже здесь.',
    );
    expect(render({ ...unknown, interest: null }, 'en')).toBe(
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
