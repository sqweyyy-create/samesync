import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentChecksum, loadValidContent, type ContentBundle } from '@samesync/content';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT_DIR } from '../../src/config';
import { assertContentSeeded, seedContent } from '../../src/content/seed';
import { runMigrations } from '../../src/db/migrate';
import { appRolePool, createEmptyDatabase } from '../support/db';
import { birthDateYearsAgo, insertUser } from '../support/users';

let db: Awaited<ReturnType<typeof createEmptyDatabase>>;
let owner: pg.Pool;
let app: pg.Pool;
let bundle: ContentBundle;
const tmp: string[] = [];

beforeAll(async () => {
  db = await createEmptyDatabase();
  await runMigrations(db.url);
  owner = new pg.Pool({ connectionString: db.url, max: 2 });
  app = appRolePool(db.url);
  bundle = await loadValidContent(DEFAULT_CONTENT_DIR);
});
afterAll(async () => {
  await Promise.all([owner.end(), app.end()]);
  await db.drop();
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true });
});

const seed = (b: ContentBundle) => seedContent(owner, b, contentChecksum(b));
const count = async (table: string) =>
  Number((await owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);
const withRelease = (b: ContentBundle, version: string): ContentBundle => ({
  ...b,
  release: { schemaVersion: 1, version },
});

describe('pnpm content:seed', () => {
  it('seeds every ID and the release, then is a no-op for the same content', async () => {
    expect(await seed(bundle)).toEqual({ status: 'seeded', version: bundle.release?.version });
    expect(await count('questions')).toBe(bundle.questions.length);
    expect(await count('interest_categories')).toBe(bundle.categories.length);
    expect(await count('interest_items')).toBe(bundle.items.length);
    expect(await count('dating_options')).toBe(bundle.genders.length);
    expect(await seed(bundle)).toEqual({ status: 'unchanged', version: bundle.release?.version });
    expect(await count('content_releases')).toBe(1);
    await assertContentSeeded(owner, bundle.release!.version, contentChecksum(bundle));
  });

  it('refuses changed content under an already seeded version', async () => {
    const changed = {
      ...bundle,
      questions: bundle.questions.map((q, i) => (i === 0 ? { ...q, priorAgree: 0.42 } : q)),
    };
    await expect(seed(changed)).rejects.toThrow(/bump the version in content\/release.json/);
  });

  it('retires a question in a new release and keeps existing answers', async () => {
    const question = bundle.questions[0]!;
    const { id: userId } = await insertUser(app, {
      birthDate: birthDateYearsAgo(20),
      mode: 'friends',
    });
    await owner.query(
      "INSERT INTO answers (user_id, question_id, value, content_release, answered_at) VALUES ($1, $2, 'agree', $3, now())",
      [userId, question.id, bundle.release!.version],
    );
    const retired = withRelease(
      {
        ...bundle,
        questions: bundle.questions.map((q) =>
          q.id === question.id ? { ...q, retiredIn: '2026.10.2' } : q,
        ),
      },
      '2026.10.2',
    );
    expect(await seed(retired)).toEqual({ status: 'seeded', version: '2026.10.2' });
    const { rows } = await owner.query<{ retired_in: string; added_in: string }>(
      'SELECT retired_in, added_in FROM questions WHERE id = $1',
      [question.id],
    );
    expect(rows[0]).toEqual({ retired_in: '2026.10.2', added_in: bundle.release!.version });
    expect(await count('answers')).toBe(1);
  });

  it('refuses an older release than one already seeded', async () => {
    await expect(seed(withRelease(bundle, '2026.09.9'))).rejects.toThrow(
      /older than the already seeded release 2026.10.2/,
    );
  });

  it('refuses to drop an ID that is already seeded', async () => {
    const dropped = withRelease({ ...bundle, items: bundle.items.slice(1) }, '2026.10.3');
    await expect(seed(dropped)).rejects.toThrow(/IDs are permanent/);
  });

  it('assertContentSeeded rejects a release that was never seeded or a different checksum', async () => {
    await expect(assertContentSeeded(owner, '2099.01.1', 'x')).rejects.toThrow(
      /not seeded: run pnpm content:seed/,
    );
    await expect(assertContentSeeded(owner, '2026.10.2', 'not-the-checksum')).rejects.toThrow(
      /content changed/,
    );
  });

  it('refuses to run at all when a text changed without a revision bump (lockfile)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'samesync-seed-'));
    tmp.push(dir);
    for (const entry of [
      'questions',
      'interests',
      'dating',
      'openers',
      'aliases',
      'products.json',
      'release.json',
      'content.lock.json',
    ]) {
      cpSync(join(DEFAULT_CONTENT_DIR, entry), join(dir, entry), { recursive: true });
    }
    const file = join(dir, 'questions/core.json');
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      questions: Array<{ id: string; text: { ru: string } }>;
    };
    json.questions[0]!.text.ru = `${json.questions[0]!.text.ru}!`;
    writeFileSync(file, JSON.stringify(json));
    await expect(loadValidContent(dir)).rejects.toThrow(
      new RegExp(
        `${json.questions[0]!.id.replaceAll('.', '\\.')}: text changed without a revision bump`,
      ),
    );
  });
});
