import { describe, expect, it } from 'vitest';
import { drawDeck, isValidTimezone, nextStep, type OnboardingState } from './onboarding';

const base: OnboardingState = {
  status: 'onboarding',
  localeConfirmed: true,
  birthDate: '2000-01-01',
  band: 'adult',
  mode: 'friends',
  answered: 25,
  interests: 5,
  onboarded: false,
};

describe('nextStep', () => {
  it.each([
    ['locale', { localeConfirmed: false }],
    ['birth_date', { birthDate: null, band: null, mode: null }],
    ['ineligible', { band: null, mode: null, status: 'ineligible' as const }],
    ['mode', { mode: null }],
    ['answers', { answered: 24 }],
    ['interests', { interests: 4 }],
    ['finish', {}],
    ['done', { onboarded: true, status: 'active' as const }],
  ] as const)('→ %s', (step, over) => {
    expect(nextStep({ ...base, ...over })).toBe(step);
  });

  it('asks for the language before anything else', () => {
    expect(nextStep({ ...base, localeConfirmed: false, birthDate: null })).toBe('locale');
  });
});

describe('drawDeck', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `q.t${String(i).padStart(2, '0')}`);

  it('draws the requested number of distinct takes from the candidates', () => {
    const deck = drawDeck(ids, 'user-1', 35);
    expect(deck).toHaveLength(35);
    expect(new Set(deck).size).toBe(35);
    expect(deck.every((id) => ids.includes(id))).toBe(true);
  });

  it('is deterministic per seed and independent of input order', () => {
    expect(drawDeck(ids, 'user-1', 35)).toEqual(drawDeck([...ids].reverse(), 'user-1', 35));
    expect(drawDeck(ids, 'user-1', 35)).not.toEqual(drawDeck(ids, 'user-2', 35));
  });

  it('returns everything when there are fewer candidates than the deck size', () => {
    expect(drawDeck(ids.slice(0, 10), 'user-1', 35).sort()).toEqual(ids.slice(0, 10));
  });
});

describe('isValidTimezone', () => {
  it.each(['Europe/Moscow', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+3'])(
    'accepts %s',
    (tz) => {
      expect(isValidTimezone(tz)).toBe(true);
    },
  );
  it.each(['Mars/Olympus', '', 'Europe/Moscow; DROP TABLE', '../etc'])('rejects %j', (tz) => {
    expect(isValidTimezone(tz)).toBe(false);
  });
});
