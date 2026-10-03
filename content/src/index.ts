import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  checkContent,
  checkLaunchCoverage,
  DECKS,
  LAUNCH,
  LIMITS,
  MIN_ALIASES,
  type ContentBundle,
  type ContentIssue,
} from './check';
import { loadContent } from './load';
import { buildLock, LOCK_FILE, lockIssues, lockViolations, serializeLock } from './lock';

export * from './schema';
export {
  checkContent,
  checkLaunchCoverage,
  DECKS,
  LAUNCH,
  LIMITS,
  MIN_ALIASES,
  loadContent,
  LOCK_FILE,
  type ContentBundle,
  type ContentIssue,
};

export interface ValidateOptions {
  /** Also require launch-sized decks and catalog (`content:check --launch`). */
  launch?: boolean;
  /** Skip the lockfile comparison (used while rewriting the lockfile). */
  skipLock?: boolean;
}

/** Loads `root` and runs every check. An empty `issues` list means the content is valid. */
export async function validateContentDir(
  root: string,
  options: ValidateOptions = {},
): Promise<{ bundle: ContentBundle; issues: ContentIssue[] }> {
  const { bundle, issues, lockFilePresent } = await loadContent(root);
  const all = [...issues, ...checkContent(bundle)];
  // A present-but-invalid lockfile is already reported by the loader.
  if (!options.skipLock && (bundle.lock || !lockFilePresent))
    all.push(...lockIssues(bundle, bundle.lock));
  if (options.launch) all.push(...checkLaunchCoverage(bundle));
  return { bundle, issues: all };
}

/**
 * Rewrites content.lock.json from the current content, unless that would hide a forbidden change
 * (a removed ID, a lowered revision, or a text changed without a revision bump).
 */
export async function writeLockFile(
  root: string,
): Promise<{ issues: ContentIssue[]; written: boolean }> {
  const { bundle, issues } = await validateContentDir(root, { skipLock: true });
  const blocking = [...issues, ...lockViolations(bundle, bundle.lock)];
  if (blocking.length > 0) return { issues: blocking, written: false };
  await writeFile(join(root, LOCK_FILE), serializeLock(buildLock(bundle)));
  return { issues: [], written: true };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * Checksum of the content data (not of the files: formatting doesn't matter). Seeding stores it
 * with the release version, and the server refuses to start if the seeded checksum differs.
 */
export function contentChecksum(bundle: ContentBundle): string {
  const byId = <T extends { id: string }>(list: T[]) =>
    [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  const data = {
    questions: byId(bundle.questions),
    categories: byId(bundle.categories),
    items: byId(bundle.items),
    genders: byId(bundle.genders),
    openers: byId(bundle.openers),
    aliases: byId(bundle.aliases),
    products: byId(bundle.products),
  };
  return createHash('sha256')
    .update(JSON.stringify(stable(data)))
    .digest('hex');
}

/** Loads and validates `root`, throwing with every issue listed if it isn't valid. */
export async function loadValidContent(
  root: string,
): Promise<ContentBundle & { release: NonNullable<ContentBundle['release']> }> {
  const { bundle, issues } = await validateContentDir(root);
  if (issues.length > 0 || !bundle.release) {
    throw new Error(
      `content in ${root} is invalid:\n${issues.map((i) => `  - ${i.id}: ${i.message}`).join('\n')}`,
    );
  }
  return { ...bundle, release: bundle.release };
}
