/**
 * content.lock.json records, for every entry that has text, its `revision` and a hash of all its
 * localized texts. It makes two rules enforceable:
 * - a text can't change without a `revision` bump (typo fixes are visible in review);
 * - an ID can't disappear (IDs are permanent: retire entries instead of deleting them).
 */
import { createHash } from 'node:crypto';
import type { ContentBundle, ContentIssue } from './check';
import type { LocalizedText, Lock } from './schema';
import { SCHEMA_VERSION } from './schema';

export const LOCK_FILE = 'content.lock.json';

interface TextEntry {
  id: string;
  revision: number;
  texts: Record<string, LocalizedText>;
}

function textEntries(bundle: ContentBundle): TextEntry[] {
  return [
    ...bundle.questions.map((e) => ({ id: e.id, revision: e.revision, texts: { text: e.text } })),
    ...bundle.categories.map((e) => ({ id: e.id, revision: e.revision, texts: { name: e.name } })),
    ...bundle.items.map((e) => ({ id: e.id, revision: e.revision, texts: { name: e.name } })),
    ...bundle.genders.map((e) => ({
      id: e.id,
      revision: e.revision,
      texts: { self: e.self, seeking: e.seeking },
    })),
    ...bundle.openers.map((e) => ({ id: e.id, revision: e.revision, texts: { text: e.text } })),
    ...bundle.aliases.map((e) => ({ id: e.id, revision: e.revision, texts: { text: e.text } })),
    ...bundle.products.map((e) => ({
      id: e.id,
      revision: e.revision,
      texts: { title: e.title, description: e.description },
    })),
  ];
}

/** Hash of the texts only: field names and locales in a fixed order, so key order never matters. */
function hashTexts(texts: Record<string, LocalizedText>): string {
  const canonical = Object.keys(texts)
    .sort()
    .map((field) => {
      const text = texts[field] ?? {};
      const locales = Object.keys(text).sort() as Array<keyof LocalizedText>;
      return [field, locales.map((l) => [l, text[l]])];
    });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildLock(bundle: ContentBundle): Lock {
  const entries: Lock['entries'] = {};
  for (const e of textEntries(bundle).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    entries[e.id] = { revision: e.revision, hash: hashTexts(e.texts) };
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

export function serializeLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}

/**
 * Problems that forbid writing a new lock: a removed ID, a revision that went down, or a text that
 * changed under the same revision. New entries and properly bumped ones are fine.
 */
export function lockViolations(bundle: ContentBundle, lock: Lock | null): ContentIssue[] {
  if (!lock) return [];
  const issues: ContentIssue[] = [];
  const current = new Map(textEntries(bundle).map((e) => [e.id, e]));
  for (const [id, locked] of Object.entries(lock.entries)) {
    const entry = current.get(id);
    if (!entry) {
      issues.push({
        id,
        message: 'was removed, but IDs are permanent: keep the entry and set `retiredIn` instead',
      });
      continue;
    }
    if (entry.revision < locked.revision) {
      issues.push({
        id,
        message: `revision went down from ${locked.revision} to ${entry.revision}`,
      });
    } else if (entry.revision === locked.revision && hashTexts(entry.texts) !== locked.hash) {
      issues.push({
        id,
        message: `text changed without a revision bump (revision is ${entry.revision}; set it to ${entry.revision + 1})`,
      });
    }
  }
  return issues;
}

/** Every difference between the content and the lock, for `content:check`. */
export function lockIssues(bundle: ContentBundle, lock: Lock | null): ContentIssue[] {
  if (!lock) {
    return [{ id: LOCK_FILE, message: 'is missing: run `pnpm content:lock` and commit the file' }];
  }
  const violations = lockViolations(bundle, lock);
  const blocked = new Set(violations.map((v) => v.id));
  const fresh = buildLock(bundle).entries;
  const stale = Object.entries(fresh).filter(([id, entry]) => {
    if (blocked.has(id)) return false;
    const locked = lock.entries[id];
    return !locked || locked.revision !== entry.revision || locked.hash !== entry.hash;
  });
  const out = [...violations];
  if (stale.length > 0) {
    out.push({
      id: LOCK_FILE,
      message: `is out of date for ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} (e.g. ${stale[0]?.[0]}): run \`pnpm content:lock\` and commit the file`,
    });
  }
  return out;
}
