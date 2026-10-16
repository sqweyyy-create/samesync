/**
 * The under-18 contact filter (PLAN.md Phase 5): every entry of the fixed corpora of real-world
 * evasions is caught, every harmless entry goes through, generated disguises are caught too, and
 * a contact split across messages is found in the window.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  collapseSpaced,
  findContact,
  findContactInWindow,
  longestDigitRun,
  normalize,
  type ContactKind,
} from './contact-filter';

interface Corpus {
  positives: Array<{ text: string; kind?: ContactKind }>;
  negatives: string[];
}

const corpus = (locale: 'ru' | 'en'): Corpus =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../../../test/fixtures/contact-filter/${locale}.json`, import.meta.url),
      ),
      'utf8',
    ),
  ) as Corpus;

describe.each(['ru', 'en'] as const)('the %s corpus', (locale) => {
  const { positives, negatives } = corpus(locale);

  it('has at least 150 entries', () => {
    expect(positives.length + negatives.length).toBeGreaterThanOrEqual(150);
  });

  it.each(positives.map((p) => [p.text, p.kind ?? 'any'] as const))(
    'catches %j (%s)',
    (text, kind) => {
      const found = findContact(text);
      expect(found).not.toBeNull();
      if (kind !== 'any') expect(found).toBe(kind);
    },
  );

  it.each(negatives.map((n) => [n] as const))('lets %j through', (text) => {
    expect(findContact(text)).toBeNull();
  });

  it('lets any three harmless messages through when read together', () => {
    for (let i = 0; i + 2 < negatives.length; i += 3) {
      const window = negatives.slice(i, i + 2);
      expect({ window, found: findContactInWindow(window, negatives[i + 2]!) }).toEqual({
        window,
        found: null,
      });
    }
  });
});

describe('the sliding window', () => {
  it.each([
    [['мой номер', '8926'], '123 45 67', 'phone'],
    [['пиши в ватсап', '+7 926'], '123-45-67', 'phone'],
    [['@'], 'ivan_08', 'handle'],
    [['пиши в тг'], 'ivan_08', 'social'],
    [['t'], 'me/ivan_08', 'url'],
    [['ivan собака gmail'], 'точка com', 'email'],
    [['восемь девять два', 'шесть один два'], 'три четыре пять шесть семь', 'phone'],
    [['my snap'], 'ivan_08', 'social'],
    [['five five five'], 'one two three four five six seven', 'phone'],
  ] as const)('catches %j followed by %j as %s', (recent, text, kind) => {
    expect(findContact(text)).not.toBe(kind === 'phone' ? 'phone' : undefined);
    expect(findContactInWindow([...recent], text)).toBe(kind);
  });

  it('judges a message on its own when there is no earlier message', () => {
    expect(findContactInWindow([], '123 45 67')).toBeNull();
    expect(findContactInWindow([], '@ivan_08')).toBe('handle');
  });

  it('does not let three harmless numbers in a row look like a phone number when words separate them', () => {
    expect(findContactInWindow(['я набрал 100 очков', 'а ты 250'], 'и ещё 3000')).toBeNull();
  });
});

describe('normalization', () => {
  it('folds case, compatibility forms, invisible characters and look-alikes', () => {
    const n = normalize('ＩＶＡＮ​_​𝟎𝟖 Іvаn');
    expect(n.plain).toBe('ivan_08 іvаn');
    expect(n.latin).toBe('ivan_08 ivan');
    expect(normalize('ПРИВЕТ, ёж').plain).toBe('привет, еж');
    expect(normalize('cat').cyrillic).toBe('сат');
  });

  it('reads "собака" and "точка" as @ and . and joins spaced-out characters', () => {
    expect(normalize('ivan собака gmail точка com').plain).toBe('ivan @ gmail.com');
    expect(normalize('ivan (at) gmail (dot) com').plain).toBe('ivan @ gmail.com');
    expect(collapseSpaced('пиши i v a n _ 0 8 мне')).toBe('пиши ivan_08 мне');
    expect(collapseSpaced('t . m e')).toBe('t.me');
    expect(collapseSpaced('я и ты')).toBe('я и ты');
  });

  it('counts digits as a phone number does, with number words and a letter o for a zero', () => {
    expect(longestDigitRun('8 (926) 123-45-67')).toBe(11);
    expect(longestDigitRun('восемь девять два шесть')).toBe(4);
    expect(longestDigitRun('89о6123')).toBe(7);
    expect(longestDigitRun('14.02.2026 в 19:30')).toBe(0);
    expect(longestDigitRun('2 + 2 = 4')).toBe(2);
    expect(longestDigitRun('ten')).toBe(2);
  });
});

// --- generated disguises -------------------------------------------------------------------------

const SAFE_WORDS_RU = [
  'привет',
  'как',
  'дела',
  'кино',
  'завтра',
  'школа',
  'игра',
  'норм',
  'ок',
  'слушай',
];
const SAFE_WORDS_EN = [
  'hello',
  'how',
  'are',
  'you',
  'movie',
  'tomorrow',
  'school',
  'game',
  'fine',
  'listen',
];
const safeSentence = (words: string[]) =>
  fc.array(fc.constantFrom(...words), { minLength: 0, maxLength: 4 }).map((w) => w.join(' '));
const wrap = (inner: fc.Arbitrary<string>, words: string[]) =>
  fc
    .tuple(safeSentence(words), inner, safeSentence(words))
    .map(([before, text, after]) => `${before} ${text} ${after}`.trim());

const RU_DIGIT_WORDS = [
  'ноль',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
];
const EN_DIGIT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
];
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  y: 'у',
  x: 'х',
  k: 'к',
  m: 'м',
  t: 'т',
  h: 'н',
  b: 'в',
};
const disguise = (text: string, mask: boolean[]) =>
  [...text].map((ch, i) => (mask[i % mask.length] && HOMOGLYPHS[ch]) || ch).join('');

const digits = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 10, maxLength: 11 });
const groups = (d: number[], sizes: number[]) => {
  const out: string[] = [];
  let at = 0;
  for (const size of sizes) {
    out.push(d.slice(at, at + size).join(''));
    at += size;
  }
  if (at < d.length) out.push(d.slice(at).join(''));
  return out;
};
const phoneForms = fc.tuple(digits, fc.integer({ min: 0, max: 8 })).map(([d, form]) => {
  const g = groups(d, d.length === 11 ? [1, 3, 3, 2, 2] : [3, 3, 2, 2]);
  const [a, b, c, e, f] = g.length === 5 ? g : ['', ...g];
  switch (form) {
    case 0:
      return d.join('');
    case 1:
      return `+${g.join(' ')}`;
    case 2:
      return `${a} (${b}) ${c}-${e}-${f}`.trim();
    case 3:
      return g.join('.');
    case 4:
      return d.join(' ');
    case 5:
      return d.map((n) => RU_DIGIT_WORDS[n]).join(' ');
    case 6:
      return d.map((n) => EN_DIGIT_WORDS[n]).join(' ');
    case 7:
      return d.map((n, i) => (i % 2 ? String(n) : RU_DIGIT_WORDS[n])).join(' ');
    default:
      return g.join('-');
  }
});

const handleName = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{2,8}$/),
    fc.constantFrom('_', '.', ''),
    fc.stringMatching(/^[0-9]{1,4}$/),
  )
  .map(([head, sep, tail]) => `${head}${sep}${tail}`);
const mask = fc.array(fc.boolean(), { minLength: 1, maxLength: 6 });
const RU_SOCIAL = ['тг', 'инста', 'вк', 'дискорд', 'снап', 'тикток', 'ник', 'телега'];
const EN_SOCIAL = ['tg', 'insta', 'vk', 'discord', 'snap', 'tiktok', 'nick', 'telegram'];
const handleForms = fc
  .tuple(
    handleName,
    mask,
    fc.integer({ min: 0, max: 5 }),
    fc.constantFrom(...RU_SOCIAL),
    fc.constantFrom(...EN_SOCIAL),
  )
  .map(([name, m, form, ru, en]) => {
    switch (form) {
      case 0:
        return `@${name}`;
      case 1:
        return `@${disguise(name, m)}`;
      case 2:
        return `@ ${[...name].join(' ')}`;
      case 3:
        return `${ru}: ${name}`;
      case 4:
        return `${en} ${name}`;
      default:
        return `${ru} ${disguise(name, m)}`;
    }
  });

const TLDS = ['com', 'net', 'org', 'ru', 'io', 'gg'];
const label = fc.stringMatching(/^[a-z][a-z0-9]{2,10}$/);
const urlForms = fc
  .tuple(label, fc.constantFrom(...TLDS), handleName, fc.integer({ min: 0, max: 7 }))
  .map(([site, tld, name, form]) => {
    switch (form) {
      case 0:
        return `${site}.${tld}`;
      case 1:
        return `${site} . ${tld}`;
      case 2:
        return `${site} точка ${tld}`;
      case 3:
        return `${site} dot ${tld}`;
      case 4:
        return `https://${site}.${tld}/${name}`;
      case 5:
        return `t.me/${name}`;
      case 6:
        return `t me ${name}`;
      default:
        return `www.${site}.${tld}`;
    }
  });

describe('generated disguises', () => {
  it('catches phone numbers however they are written', () => {
    fc.assert(
      fc.property(wrap(phoneForms, SAFE_WORDS_RU), (text) => findContact(text) === 'phone'),
      { numRuns: 300 },
    );
  });

  it('catches handles behind look-alikes, spacing and social-network names', () => {
    fc.assert(
      // A name of nine digits or more is reported as a phone number: still a hit.
      fc.property(wrap(handleForms, SAFE_WORDS_EN), (text) => findContact(text) !== null),
      { numRuns: 300 },
    );
  });

  it('catches links and domains however the dot is written', () => {
    fc.assert(
      fc.property(wrap(urlForms, SAFE_WORDS_RU), (text) => findContact(text) === 'url'),
      { numRuns: 300 },
    );
  });

  it('lets harmless talk with small numbers, times and dates through', () => {
    const number = fc.integer({ min: 0, max: 9999 }).map(String);
    const time = fc
      .tuple(fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
      .map(([h, m]) => `${h}:${String(m).padStart(2, '0')}`);
    const date = fc
      .tuple(
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 2000, max: 2030 }),
      )
      .map(([d, m, y]) => `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`);
    const word = fc.constantFrom(...SAFE_WORDS_RU, ...SAFE_WORDS_EN);
    const piece = fc.oneof(word, number, time, date);
    // Words and numbers take turns, as they do in talk: nobody sends three bare numbers in a row.
    const sentence = fc
      .array(fc.tuple(word, piece), { minLength: 1, maxLength: 4 })
      .map((pairs) => pairs.flat().join(' '));
    fc.assert(
      fc.property(
        sentence,
        sentence,
        sentence,
        (a, b, c) => findContactInWindow([a, b], c) === null,
      ),
      { numRuns: 500 },
    );
  });

  it('never throws, whatever the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (text) => {
        findContact(text);
        return true;
      }),
      { numRuns: 500 },
    );
  });
});
