import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateContentDir } from '../src/index';

const contentRoot = fileURLToPath(new URL('..', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe('content:check', () => {
  it('accepts the committed sample content', async () => {
    const { bundle, issues } = await validateContentDir(contentRoot);
    expect(issues).toEqual([]);
    expect(bundle.questions.length).toBeGreaterThan(0);
    expect(bundle.items.length).toBeGreaterThan(0);
  });

  it('rejects content that fails schema validation', async () => {
    const { issues } = await validateContentDir(fixture('bad-schema'));
    const messages = issues.map((i) => i.message).join('\n');
    expect(messages).toMatch(/questions\.0\.id/);
    expect(messages).toMatch(/questions\.0\.priorAgree/);
    expect(messages).toMatch(/unexpected/i);
  });

  it('rejects a text that is missing one of its locales', async () => {
    const { issues } = await validateContentDir(fixture('missing-locale'));
    expect(issues).toEqual([
      { id: 'q.only_russian_text', message: 'text is missing locale(s): en' },
    ]);
  });

  it('rejects duplicate IDs', async () => {
    const { issues } = await validateContentDir(fixture('duplicate-id'));
    expect(issues).toEqual([{ id: 'q.twice', message: 'duplicate id' }]);
  });

  it('rejects references to unknown categories and questions', async () => {
    const { issues } = await validateContentDir(fixture('dangling-reference'));
    expect(issues).toEqual([
      { id: 'i.music.orphan', message: 'references unknown category c.music.does_not_exist' },
      { id: 'o.no_question.agree', message: 'references unknown question q.does_not_exist' },
    ]);
  });
});
