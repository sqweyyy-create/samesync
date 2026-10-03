import { describe, expect, it } from 'vitest';
import { prng } from '../random';
import { pickAliases } from './alias';

const ALIASES = ['a.otter', 'a.fox', 'a.owl', 'a.lynx'];
const none = new Set<string>();

describe('pickAliases', () => {
  it('gives the two users different names', () => {
    for (let seed = 0; seed < 50; seed++) {
      const { aliasA, aliasB } = pickAliases(ALIASES, none, none, prng(seed));
      expect(ALIASES).toContain(aliasA);
      expect(ALIASES).toContain(aliasB);
      expect(aliasA).not.toBe(aliasB);
    }
  });

  it('avoids names the other user already sees in open matches', () => {
    for (let seed = 0; seed < 50; seed++) {
      // B already chats with an otter and a fox, so A must appear as something else.
      const { aliasA, aliasB } = pickAliases(
        ALIASES,
        new Set(['a.owl']),
        new Set(['a.otter', 'a.fox']),
        prng(seed),
      );
      expect(['a.owl', 'a.lynx']).toContain(aliasA);
      expect(aliasB).not.toBe('a.owl');
      expect(aliasB).not.toBe(aliasA);
    }
  });

  it('falls back to any other name when everything is in use', () => {
    const all = new Set(ALIASES);
    const { aliasA, aliasB } = pickAliases(ALIASES, all, all, prng(1));
    expect(aliasA).not.toBe(aliasB);
  });

  it('is deterministic for a seed', () => {
    expect(pickAliases(ALIASES, none, none, prng(9))).toEqual(
      pickAliases(ALIASES, none, none, prng(9)),
    );
  });

  it('needs at least two aliases', () => {
    expect(() => pickAliases(['a.otter'], none, none, prng(1))).toThrow(/at least two/);
  });
});
