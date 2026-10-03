import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  contentChecksum,
  validateContentDir,
  writeLockFile,
  type ContentIssue,
} from '../src/index';

const contentRoot = fileURLToPath(new URL('..', import.meta.url));
const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

const take = (over: Record<string, unknown> = {}) => ({
  id: 'q.sample',
  locales: ['ru', 'en'],
  audiences: ['u18', 'adult'],
  modes: ['friends', 'dating'],
  priorAgree: 0.5,
  text: { ru: 'Текст', en: 'Text' },
  ...over,
});
const category = (over: Record<string, unknown> = {}) => ({
  id: 'c.music.post_punk',
  domain: 'music',
  locales: ['ru', 'en'],
  audiences: ['u18', 'adult'],
  name: { ru: 'Пост-панк', en: 'Post-punk' },
  ...over,
});
const item = (over: Record<string, unknown> = {}) => ({
  id: 'i.music.molchat_doma',
  categoryId: 'c.music.post_punk',
  popularity: 'known',
  locales: ['ru', 'en'],
  audiences: ['u18', 'adult'],
  name: { ru: 'Молчат Дома', en: 'Molchat Doma' },
  ...over,
});
const GENDERS = {
  schemaVersion: 1,
  genders: [
    { id: 'g.man', self: { ru: 'Мужчина', en: 'Man' }, seeking: { ru: 'Мужчин', en: 'Men' } },
    { id: 'g.woman', self: { ru: 'Женщина', en: 'Woman' }, seeking: { ru: 'Женщин', en: 'Women' } },
  ],
};
const alias = (slug: string, emoji = '🦊') => ({
  id: `a.${slug}`,
  emoji,
  text: { ru: 'Лиса', en: 'Fox' },
});
const ALIASES = { schemaVersion: 1, aliases: [alias('fox'), alias('owl', '🦉')] };
const BASE: Record<string, unknown> = {
  'release.json': { schemaVersion: 1, version: '2026.10.1' },
  'dating/genders.json': GENDERS,
  'aliases/animals.json': ALIASES,
};

/** Writes a content root: the valid base files plus `files` (null removes a base file). */
function root(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'samesync-content-'));
  tmpRoots.push(dir);
  for (const [path, body] of Object.entries({ ...BASE, ...files })) {
    if (body === null) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}
const takes = (...qs: unknown[]) => ({ 'questions/a.json': { schemaVersion: 1, questions: qs } });
const interests = (categories: unknown[], items: unknown[]) => ({
  'interests/a.json': { schemaVersion: 1, categories, items },
});

/** Issues other than the missing lockfile, which most cases don't care about. */
async function issuesOf(dir: string, launch = false): Promise<ContentIssue[]> {
  const { issues } = await validateContentDir(dir, { launch });
  return issues.filter((i) => i.id !== 'content.lock.json');
}

describe('content:check on the committed content', () => {
  it('passes, including the lockfile', async () => {
    const { bundle, issues } = await validateContentDir(contentRoot);
    expect(issues).toEqual([]);
    expect(bundle.release?.version).toMatch(/^\d{4}\.\d{2}\.\d+$/);
    expect(bundle.genders.map((g) => g.id)).toEqual(['g.man', 'g.woman']);
  });

  it('passes the launch coverage check', async () => {
    expect((await validateContentDir(contentRoot, { launch: true })).issues).toEqual([]);
  });
});

describe('format and references', () => {
  it('accepts a minimal valid root', async () => {
    expect(await issuesOf(root(takes(take())))).toEqual([]);
  });

  it('rejects content that fails schema validation', async () => {
    const issues = await issuesOf(
      root(takes(take({ id: 'Q-NOT-A-SLUG', priorAgree: 1.5, unexpected: true }))),
    );
    const messages = issues.map((i) => i.message).join('\n');
    expect(messages).toMatch(/questions\.0\.id/);
    expect(messages).toMatch(/questions\.0\.priorAgree/);
    expect(messages).toMatch(/unexpected/i);
  });

  it('rejects a text that is missing one of its locales', async () => {
    expect(await issuesOf(root(takes(take({ text: { ru: 'Только русский' } }))))).toEqual([
      { id: 'q.sample', message: 'text is missing locale(s): en' },
    ]);
  });

  it('rejects duplicate IDs', async () => {
    expect(await issuesOf(root(takes(take(), take())))).toEqual([
      { id: 'q.sample', message: 'duplicate id' },
    ]);
  });

  it('rejects references to unknown categories and questions', async () => {
    const dir = root({
      ...interests([], [item({ id: 'i.music.orphan', categoryId: 'c.music.does_not_exist' })]),
      'openers/a.json': {
        schemaVersion: 1,
        openers: [
          {
            id: 'o.x.agree',
            questionId: 'q.does_not_exist',
            side: 'agree',
            text: { ru: 'Почему?', en: 'Why?' },
          },
        ],
      },
    });
    expect(await issuesOf(dir)).toEqual([
      { id: 'i.music.orphan', message: 'references unknown category c.music.does_not_exist' },
      { id: 'o.x.agree', message: 'references unknown question q.does_not_exist' },
    ]);
  });
});

describe('Phase 1 fields', () => {
  it('accepts revision, retiredIn and searchTerms, with revision defaulting to 1', async () => {
    const dir = root({
      ...takes(take({ revision: 3 }), take({ id: 'q.old', retiredIn: '2026.10.1' })),
      ...interests([category()], [item({ searchTerms: { ru: ['молчат'], en: ['md'] } })]),
    });
    const { bundle } = await validateContentDir(dir);
    expect(await issuesOf(dir)).toEqual([]);
    expect(bundle.questions.map((q) => q.revision)).toEqual([3, 1]);
  });

  it('requires release.json with a valid version', async () => {
    expect(await issuesOf(root({ 'release.json': null }))).toContainEqual({
      id: 'release.json',
      message: 'is missing: every content root declares its release version',
    });
    const bad = await issuesOf(root({ 'release.json': { schemaVersion: 1, version: 'v1' } }));
    expect(bad.map((i) => i.id)).toContain('release.json');
  });

  it('rejects retiredIn later than the current release', async () => {
    expect(await issuesOf(root(takes(take({ retiredIn: '2026.11.1' }))))).toEqual([
      {
        id: 'q.sample',
        message: 'retiredIn 2026.11.1 is later than the current release 2026.10.1',
      },
    ]);
  });

  it('rejects references to retired entries', async () => {
    const dir = root({
      ...takes(take({ retiredIn: '2026.10.1' })),
      ...interests([category({ retiredIn: '2026.10.1' })], [item()]),
      'openers/a.json': {
        schemaVersion: 1,
        openers: [
          {
            id: 'o.sample.agree',
            questionId: 'q.sample',
            side: 'agree',
            text: { ru: 'Почему?', en: 'Why?' },
          },
        ],
      },
    });
    expect(await issuesOf(dir)).toEqual([
      {
        id: 'i.music.molchat_doma',
        message: 'references retired category c.music.post_punk; retire the item too or move it',
      },
      { id: 'o.sample.agree', message: 'references retired question q.sample' },
    ]);
  });

  it('rejects searchTerms for a locale the item is not offered in', async () => {
    const dir = root(
      interests(
        [category()],
        [item({ locales: ['ru'], name: { ru: 'Молчат Дома' }, searchTerms: { en: ['md'] } })],
      ),
    );
    expect(await issuesOf(dir)).toEqual([
      {
        id: 'i.music.molchat_doma',
        message: 'searchTerms.en: the item is not offered in locale en',
      },
    ]);
  });
});

describe('dating options', () => {
  it('requires at least two active options', async () => {
    const one = {
      schemaVersion: 1,
      genders: [GENDERS.genders[0], { ...GENDERS.genders[1], retiredIn: '2026.10.1' }],
    };
    expect(await issuesOf(root({ 'dating/genders.json': one }))).toEqual([
      {
        id: 'dating',
        message: 'needs at least two dating options that are not retired (content/dating/*.json)',
      },
    ]);
  });

  it('requires both labels in both locales and the g. prefix', async () => {
    const broken = {
      schemaVersion: 1,
      genders: [
        { ...GENDERS.genders[0], seeking: { ru: 'Мужчин' } },
        { ...GENDERS.genders[1], id: 'woman' },
      ],
    };
    const issues = await issuesOf(root({ 'dating/genders.json': broken }));
    expect(issues.map((i) => i.message).join('\n')).toMatch(/genders\.1\.id/);
  });

  it('reports a missing locale on an option', async () => {
    const broken = {
      schemaVersion: 1,
      genders: [{ ...GENDERS.genders[0], seeking: { ru: 'Мужчин' } }, GENDERS.genders[1]],
    };
    expect(await issuesOf(root({ 'dating/genders.json': broken }))).toEqual([
      { id: 'g.man', message: 'seeking is missing locale(s): en' },
    ]);
  });
});

describe('chat aliases', () => {
  const aliases = (...list: unknown[]) => ({
    'aliases/animals.json': { schemaVersion: 1, aliases: list },
  });

  it('requires at least two, so a match can give its two users different names', async () => {
    const message = 'needs at least 2 chat aliases (content/aliases/*.json)';
    expect(await issuesOf(root({ ...takes(take()), 'aliases/animals.json': null }))).toEqual([
      { id: 'aliases', message },
    ]);
    expect(await issuesOf(root({ ...takes(take()), ...aliases(alias('fox')) }))).toEqual([
      { id: 'aliases', message },
    ]);
  });

  it('requires the name in both locales and limits it to 40 characters', async () => {
    const issues = await issuesOf(
      root({
        ...takes(take()),
        ...aliases(
          alias('fox'),
          { ...alias('owl'), text: { ru: 'Сова' } },
          { ...alias('long'), text: { ru: 'Я'.repeat(41), en: 'Long' } },
        ),
      }),
    );
    expect(issues).toEqual([
      { id: 'a.owl', message: 'text is missing locale(s): en' },
      { id: 'a.long', message: 'text.ru is 41 characters (max 40)' },
    ]);
  });
});

describe('folder allowlist', () => {
  it('rejects misspelled folders, subfolders and non-JSON files', async () => {
    const dir = root({
      'question/a.json': { schemaVersion: 1, questions: [] },
      'questions/old/a.json': { schemaVersion: 1, questions: [] },
      'questions/notes.txt': 'notes',
      'README.md': '# hi',
    });
    expect((await issuesOf(dir)).map((i) => i.id).sort()).toEqual([
      'README.md',
      'question',
      'questions/notes.txt',
      'questions/old',
    ]);
  });

  it('ignores the package files and hidden OS files', async () => {
    const dir = root({
      'src/x.ts': 'export {}',
      'test/x.test.ts': 'export {}',
      'package.json': '{}',
      'tsconfig.json': '{}',
      '.DS_Store': 'x',
      'questions/.DS_Store': 'x',
    });
    expect(await issuesOf(dir)).toEqual([]);
  });
});

describe('consistency and length limits', () => {
  it('requires friends mode for takes shown to u18', async () => {
    expect(await issuesOf(root(takes(take({ audiences: ['u18'], modes: ['dating'] }))))).toEqual([
      {
        id: 'q.sample',
        message: 'audience u18 needs mode friends (u18 users only use friends mode)',
      },
    ]);
  });

  it("requires an item's ID to use its category's domain", async () => {
    expect(
      await issuesOf(root(interests([category()], [item({ id: 'i.games.molchat_doma' })]))),
    ).toEqual([
      {
        id: 'i.games.molchat_doma',
        message: 'id must start with "i.music." (the domain of c.music.post_punk)',
      },
    ]);
  });

  it('limits take text to 120 characters and names to 40', async () => {
    const dir = root({
      ...takes(take({ text: { ru: 'я'.repeat(121), en: 'ok' } })),
      ...interests([category({ name: { ru: 'к'.repeat(41), en: 'ok' } })], []),
    });
    expect(await issuesOf(dir)).toEqual([
      { id: 'q.sample', message: 'text.ru is 121 characters (max 120)' },
      { id: 'c.music.post_punk', message: 'name.ru is 41 characters (max 40)' },
    ]);
  });

  it('counts characters, not UTF-16 units (an emoji is one character)', async () => {
    expect(await issuesOf(root(takes(take({ text: { ru: '🍍'.repeat(120), en: 'ok' } }))))).toEqual(
      [],
    );
  });
});

describe('--launch coverage', () => {
  it('fails small content with the counts, while the normal check passes', async () => {
    const dir = root({ ...takes(take()), ...interests([category()], [item()]) });
    expect(await issuesOf(dir)).toEqual([]);
    const launch = await issuesOf(dir, true);
    expect(launch).toContainEqual({
      id: 'deck u18/friends/ru',
      message: 'has 1 takes (needs ≥ 35)',
    });
    expect(launch).toContainEqual({
      id: 'catalog en',
      message: 'has 1 items across 1 domains (needs ≥ 150 items across ≥ 4 domains)',
    });
    expect(launch).toContainEqual({
      id: 'aliases',
      message: 'has 2 chat aliases (needs ≥ 12)',
    });
    expect(launch).toHaveLength(9);
  });

  it('does not count retired entries', async () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      take({ id: `q.t${i}`, retiredIn: i === 0 ? '2026.10.1' : undefined }),
    );
    const launch = await issuesOf(root(takes(...many)), true);
    expect(launch).toContainEqual({
      id: 'deck adult/dating/en',
      message: 'has 34 takes (needs ≥ 35)',
    });
  });
});

describe('content.lock.json', () => {
  const lockedRoot = async () => {
    const dir = root({ ...takes(take()), ...interests([category()], [item()]) });
    expect(await writeLockFile(dir)).toEqual({ issues: [], written: true });
    expect((await validateContentDir(dir)).issues).toEqual([]);
    return dir;
  };
  const rewrite = (dir: string, over: Record<string, unknown>) =>
    writeFileSync(
      join(dir, 'questions/a.json'),
      JSON.stringify({ schemaVersion: 1, questions: [take(over)] }),
    );

  it('is required', async () => {
    expect((await validateContentDir(root(takes(take())))).issues).toEqual([
      {
        id: 'content.lock.json',
        message: 'is missing: run `pnpm content:lock` and commit the file',
      },
    ]);
  });

  it('fails a text change without a revision bump, and content:lock refuses to hide it', async () => {
    const dir = await lockedRoot();
    rewrite(dir, { text: { ru: 'Новый текст', en: 'Text' } });
    const expected = {
      id: 'q.sample',
      message: 'text changed without a revision bump (revision is 1; set it to 2)',
    };
    expect((await validateContentDir(dir)).issues).toEqual([expected]);
    expect(await writeLockFile(dir)).toEqual({ issues: [expected], written: false });
  });

  it('accepts the same change with a revision bump once content:lock updates the lockfile', async () => {
    const dir = await lockedRoot();
    rewrite(dir, { revision: 2, text: { ru: 'Новый текст', en: 'Text' } });
    expect((await validateContentDir(dir)).issues).toEqual([
      {
        id: 'content.lock.json',
        message:
          'is out of date for 1 entry (e.g. q.sample): run `pnpm content:lock` and commit the file',
      },
    ]);
    expect(await writeLockFile(dir)).toEqual({ issues: [], written: true });
    expect((await validateContentDir(dir)).issues).toEqual([]);
    const lock = JSON.parse(readFileSync(join(dir, 'content.lock.json'), 'utf8')) as {
      entries: Record<string, { revision: number }>;
    };
    expect(lock.entries['q.sample']?.revision).toBe(2);
  });

  it('ignores changes to fields that are not text (priorAgree, audiences)', async () => {
    const dir = await lockedRoot();
    rewrite(dir, { priorAgree: 0.7, audiences: ['adult'] });
    expect((await validateContentDir(dir)).issues).toEqual([]);
  });

  it('rejects a removed ID and a lowered revision', async () => {
    const dir = await lockedRoot();
    writeFileSync(
      join(dir, 'interests/a.json'),
      JSON.stringify({ schemaVersion: 1, categories: [category()], items: [] }),
    );
    rewrite(dir, { revision: 1 });
    const lock = JSON.parse(readFileSync(join(dir, 'content.lock.json'), 'utf8')) as {
      entries: Record<string, { revision: number }>;
    };
    lock.entries['q.sample'] = { ...lock.entries['q.sample'], revision: 2 };
    writeFileSync(join(dir, 'content.lock.json'), JSON.stringify(lock));
    const { issues } = await validateContentDir(dir);
    expect(issues).toContainEqual({
      id: 'i.music.molchat_doma',
      message: 'was removed, but IDs are permanent: keep the entry and set `retiredIn` instead',
    });
    expect(issues).toContainEqual({ id: 'q.sample', message: 'revision went down from 2 to 1' });
  });
});

describe('contentChecksum', () => {
  it('ignores formatting and key order but changes with any value', async () => {
    const a = root(takes(take()));
    const b = root({
      'questions/a.json': JSON.stringify({ questions: [take()], schemaVersion: 1 }, null, 4),
    });
    const c = root(takes(take({ priorAgree: 0.51 })));
    const sum = async (dir: string) => contentChecksum((await validateContentDir(dir)).bundle);
    expect(await sum(a)).toBe(await sum(b));
    expect(await sum(a)).not.toBe(await sum(c));
  });
});
