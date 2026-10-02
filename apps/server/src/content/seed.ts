/**
 * `pnpm content:seed`: copies content IDs and metadata into the DB (texts stay in the files).
 * Runs as the owner role. Idempotent: the same release with the same checksum is a no-op.
 * Refuses to: reuse a seeded release version for different content, go back to an older release,
 * or drop an ID that is already in the DB (IDs are permanent; retire them instead).
 */
import { compareVersions, type ContentBundle } from '@samesync/content';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { createDb } from '../db/client';
import {
  contentReleases,
  datingOptions,
  interestCategories,
  interestItems,
  questions,
} from '../db/schema/index';

export type SeedResult = { status: 'seeded' | 'unchanged'; version: string };

export class SeedError extends Error {
  override name = 'SeedError';
}

export async function seedContent(
  pool: pg.Pool,
  bundle: ContentBundle,
  checksum: string,
): Promise<SeedResult> {
  const version = bundle.release?.version;
  if (!version) throw new SeedError('content has no release.json');
  const db = createDb(pool);

  return db.transaction(async (tx) => {
    // One seeder at a time.
    await tx.execute(sql`LOCK TABLE content_releases IN EXCLUSIVE MODE`);
    const seeded = await tx.select().from(contentReleases);
    const same = seeded.find((r) => r.version === version);
    if (same) {
      if (same.checksum === checksum) return { status: 'unchanged' as const, version };
      throw new SeedError(
        `content changed since release ${version} was seeded: bump the version in content/release.json`,
      );
    }
    const latest = seeded
      .map((r) => r.version)
      .sort(compareVersions)
      .at(-1);
    if (latest && compareVersions(latest, version) > 0) {
      throw new SeedError(`release ${version} is older than the already seeded release ${latest}`);
    }

    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM questions UNION ALL SELECT id FROM interest_categories
      UNION ALL SELECT id FROM interest_items UNION ALL SELECT id FROM dating_options`);
    const present = new Set([
      ...bundle.questions.map((e) => e.id),
      ...bundle.categories.map((e) => e.id),
      ...bundle.items.map((e) => e.id),
      ...bundle.genders.map((e) => e.id),
    ]);
    const removed = existing.rows.map((r) => r.id).filter((id) => !present.has(id));
    if (removed.length > 0) {
      throw new SeedError(
        `content removed IDs that are already seeded (${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ', …' : ''}): IDs are permanent, set retiredIn instead`,
      );
    }

    await tx.insert(contentReleases).values({ version, checksum });
    const lifecycle = (e: { revision: number; retiredIn?: string | undefined }) => ({
      revision: e.revision,
      addedIn: version,
      retiredIn: e.retiredIn ?? null,
    });
    // On conflict, keep added_in (when this DB first saw the entry) and refresh everything else.
    const keepAddedIn = { revision: sql`excluded.revision`, retiredIn: sql`excluded.retired_in` };

    if (bundle.genders.length > 0) {
      await tx
        .insert(datingOptions)
        .values(bundle.genders.map((g) => ({ id: g.id, ...lifecycle(g) })))
        .onConflictDoUpdate({ target: datingOptions.id, set: keepAddedIn });
    }
    if (bundle.categories.length > 0) {
      await tx
        .insert(interestCategories)
        .values(
          bundle.categories.map((c) => ({
            id: c.id,
            domain: c.domain,
            audiences: c.audiences,
            locales: c.locales,
            ...lifecycle(c),
          })),
        )
        .onConflictDoUpdate({
          target: interestCategories.id,
          set: {
            ...keepAddedIn,
            domain: sql`excluded.domain`,
            audiences: sql`excluded.audiences`,
            locales: sql`excluded.locales`,
          },
        });
    }
    if (bundle.items.length > 0) {
      await tx
        .insert(interestItems)
        .values(
          bundle.items.map((i) => ({
            id: i.id,
            categoryId: i.categoryId,
            popularityPrior: i.popularity,
            audiences: i.audiences,
            locales: i.locales,
            ...lifecycle(i),
          })),
        )
        .onConflictDoUpdate({
          target: interestItems.id,
          set: {
            ...keepAddedIn,
            categoryId: sql`excluded.category_id`,
            popularityPrior: sql`excluded.popularity_prior`,
            audiences: sql`excluded.audiences`,
            locales: sql`excluded.locales`,
          },
        });
    }
    if (bundle.questions.length > 0) {
      await tx
        .insert(questions)
        .values(
          bundle.questions.map((q) => ({
            id: q.id,
            audiences: q.audiences,
            modes: q.modes,
            locales: q.locales,
            priorAgree: q.priorAgree,
            ...lifecycle(q),
          })),
        )
        .onConflictDoUpdate({
          target: questions.id,
          set: {
            ...keepAddedIn,
            audiences: sql`excluded.audiences`,
            modes: sql`excluded.modes`,
            locales: sql`excluded.locales`,
            priorAgree: sql`excluded.prior_agree`,
          },
        });
    }
    return { status: 'seeded' as const, version };
  });
}

/** The server refuses to start unless the DB holds exactly the content it serves. */
export async function assertContentSeeded(
  pool: pg.Pool,
  release: string,
  checksum: string,
): Promise<void> {
  const { rows } = await pool.query<{ checksum: string }>(
    'SELECT checksum FROM content_releases WHERE version = $1',
    [release],
  );
  if (!rows[0])
    throw new SeedError(`content release ${release} is not seeded: run pnpm content:seed`);
  if (rows[0].checksum !== checksum) {
    throw new SeedError(
      `content changed since release ${release} was seeded: bump content/release.json and run pnpm content:seed`,
    );
  }
}
