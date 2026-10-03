import { ageOn, birthDatesWithinYears } from '@samesync/shared';
import { describe, expect, it } from 'vitest';
import {
  generateLookalikes,
  generateProfiles,
  insertSyntheticUsers,
  type GenerateOptions,
} from '../../scripts/lib/synthetic';
import { realScope } from '../support/population';
import { todayUtc } from '../support/users';

const NOW = new Date();
const TODAY = todayUtc();
const base: GenerateOptions = {
  pool: { band: 'adult', locale: 'ru' },
  mode: 'friends',
  n: 200,
  seed: 7,
  now: NOW,
};

describe('generateProfiles', () => {
  it('gives the same profiles for the same seed, and different ones for another', async () => {
    const scope = await realScope();
    expect(generateProfiles(scope, base)).toEqual(generateProfiles(scope, base));
    expect(generateProfiles(scope, { ...base, seed: 8 })).not.toEqual(
      generateProfiles(scope, base),
    );
  });

  it('builds valid profiles: 5–30 items and a deck of takes from the pool scope', async () => {
    const scope = await realScope();
    const items = new Set(scope.items.map((i) => i.id));
    const takes = new Set(scope.takes.map((t) => t.id));
    const profiles = generateProfiles(scope, base);
    expect(profiles).toHaveLength(200);
    for (const p of profiles) {
      expect(p.items.length).toBeGreaterThanOrEqual(5);
      expect(p.items.length).toBeLessThanOrEqual(30);
      expect(new Set(p.items).size).toBe(p.items.length);
      expect(p.items.every((id) => items.has(id))).toBe(true);
      expect(p.answers).toHaveLength(35);
      expect(p.answers.every(([id]) => takes.has(id))).toBe(true);
      expect(p.answers.filter(([, v]) => v !== 'skip').length).toBeGreaterThanOrEqual(25);
      expect(ageOn(p.birthDate, TODAY)).toBeGreaterThanOrEqual(18);
      expect([p.gender, p.seeking, p.datingAge]).toEqual([null, null, null]);
    }
    // Rare items stay rare: far fewer people pick a niche item than a mainstream one.
    const share = (popularity: string) => {
      const ids = scope.items.filter((i) => i.popularity === popularity).map((i) => i.id);
      const picks = profiles.reduce(
        (n, p) => n + p.items.filter((id) => ids.includes(id)).length,
        0,
      );
      return picks / (ids.length * profiles.length);
    };
    expect(share('mainstream')).toBeGreaterThan(share('known'));
    expect(share('known')).toBeGreaterThan(share('niche'));
  });

  it('keeps u18 users between 14 and 17, and refuses u18 dating', async () => {
    const u18 = { ...base, pool: { band: 'u18', locale: 'ru' } as const };
    const scope = await realScope({ band: 'u18' });
    for (const p of generateProfiles(scope, u18)) {
      const age = ageOn(p.birthDate, TODAY);
      expect(age).toBeGreaterThanOrEqual(14);
      expect(age).toBeLessThanOrEqual(17);
    }
    expect(() => generateProfiles(scope, { ...u18, mode: 'dating' })).toThrow(/friends-only/);
  });

  it('makes dating users who fit the real user in both directions', async () => {
    const scope = await realScope({ mode: 'dating' });
    const target = {
      birthDate: `${Number(TODAY.slice(0, 4)) - 27}-01-15`,
      gender: 'g.woman',
      seeking: ['g.man'],
      datingAge: { min: 25, max: 31 },
    };
    const targetAge = ageOn(target.birthDate, TODAY);
    for (const p of generateProfiles(scope, { ...base, mode: 'dating', compatibleWith: target })) {
      expect(p.gender).toBe('g.man');
      expect(p.seeking).toContain('g.woman');
      const age = ageOn(p.birthDate, TODAY);
      expect(age).toBeGreaterThanOrEqual(25);
      expect(age).toBeLessThanOrEqual(31);
      expect(p.datingAge!.min).toBeLessThanOrEqual(targetAge);
      expect(p.datingAge!.max).toBeGreaterThanOrEqual(targetAge);
      expect(p.datingAge!.min).toBeGreaterThanOrEqual(18);
    }
  });

  it('keeps u18 users within two calendar years of the real user', async () => {
    const scope = await realScope({ band: 'u18' });
    const target = {
      birthDate: `${Number(TODAY.slice(0, 4)) - 16}-01-01`,
      gender: null,
      seeking: null,
      datingAge: null,
    };
    const profiles = generateProfiles(scope, {
      ...base,
      pool: { band: 'u18', locale: 'ru' },
      compatibleWith: target,
    });
    for (const p of profiles) {
      expect(birthDatesWithinYears(p.birthDate, target.birthDate, 2)).toBe(true);
    }
  });
});

describe('generateLookalikes', () => {
  it('shares the real user rarest items and most answers, with at least one disagreement', async () => {
    const scope = await realScope();
    const niche = scope.items.filter((i) => i.popularity === 'niche').map((i) => i.id);
    const mainstream = scope.items.filter((i) => i.popularity === 'mainstream').map((i) => i.id);
    const real = {
      items: [mainstream[0]!, niche[0]!, mainstream[1]!, niche[1]!, 'i.not.in_scope'],
      answers: scope.takes
        .slice(0, 30)
        .map((t, i) => [t.id, i % 7 === 0 ? 'skip' : i % 2 ? 'agree' : 'disagree'] as const),
    };
    const target = { birthDate: '1999-05-05', gender: null, seeking: null, datingAge: null };
    const lookalikes = generateLookalikes(scope, { ...base, n: 3, compatibleWith: target }, real);
    expect(lookalikes).toHaveLength(3);
    const mine = new Map(real.answers);
    lookalikes.forEach((p, index) => {
      // Each one carries a different one of the rarest items first.
      expect(p.items).toContain([niche[0], niche[1], mainstream[0]][index]);
      expect(p.items).not.toContain('i.not.in_scope');
      const same = p.answers.filter(([id, value]) => mine.get(id) === value).length;
      const flipped = p.answers.filter(([id, value]) => mine.get(id) !== value).length;
      expect(same).toBeGreaterThanOrEqual(5);
      expect(flipped).toBeGreaterThanOrEqual(1);
      expect(p.answers.every(([, value]) => value !== 'skip')).toBe(true);
    });
  });
});

describe('insertSyntheticUsers', () => {
  it('refuses to create synthetic users in production, before touching the database', async () => {
    const before = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const noDatabase = { query: () => Promise.reject(new Error('must not be called')) };
      await expect(
        insertSyntheticUsers(noDatabase as never, base.pool, 'friends', [], NOW),
      ).rejects.toThrow(/never be created in production/);
    } finally {
      if (before === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = before;
    }
  });
});
