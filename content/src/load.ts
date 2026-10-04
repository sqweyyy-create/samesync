import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';
import type { ContentBundle, ContentIssue } from './check';
import { LOCK_FILE } from './lock';
import {
  AliasesFile,
  GendersFile,
  InterestsFile,
  LockFile,
  OpenersFile,
  ProductsFile,
  QuestionsFile,
  ReleaseFile,
  StancesFile,
} from './schema';

export interface LoadResult {
  bundle: ContentBundle;
  /** Schema, parse and layout problems, keyed by file path instead of content ID. */
  issues: ContentIssue[];
  /** Whether content.lock.json exists (it may still have failed to parse). */
  lockFilePresent: boolean;
}

/** Folders whose `*.json` files are content, and the file schema each one uses. */
const CONTENT_DIRS = ['questions', 'stances', 'interests', 'dating', 'openers', 'aliases'] as const;
export const RELEASE_FILE = 'release.json';
const PRODUCTS_FILE = 'products.json';
const ROOT_FILES = new Set([PRODUCTS_FILE, RELEASE_FILE, LOCK_FILE]);
/** `content/` is also a code package; these entries belong to it and are not content. */
const PACKAGE_ENTRIES = new Set(['src', 'test', 'node_modules', 'package.json', 'tsconfig.json']);

/** Hidden OS files (.DS_Store and friends) are ignored everywhere. */
const isHidden = (name: string) => name.startsWith('.');

async function entriesOf(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter((e) => !isHidden(e.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Loads and schema-validates every content file under `root`. */
export async function loadContent(root: string): Promise<LoadResult> {
  const bundle: ContentBundle = {
    questions: [],
    stances: [],
    categories: [],
    items: [],
    genders: [],
    openers: [],
    aliases: [],
    products: [],
    release: null,
    lock: null,
  };
  const issues: ContentIssue[] = [];

  async function parse<T extends z.ZodType>(label: string, schema: T): Promise<z.infer<T> | null> {
    let json: unknown;
    try {
      json = JSON.parse(await readFile(join(root, label), 'utf8'));
    } catch (error) {
      issues.push({ id: label, message: `invalid JSON: ${(error as Error).message}` });
      return null;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      for (const issue of result.error.issues) {
        issues.push({
          id: label,
          message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        });
      }
      return null;
    }
    return result.data;
  }

  // Root allowlist: content folders, known root files, and the package's own files.
  const rootEntries = await entriesOf(root);
  for (const entry of rootEntries) {
    const known = entry.isDirectory()
      ? (CONTENT_DIRS as readonly string[]).includes(entry.name) || PACKAGE_ENTRIES.has(entry.name)
      : ROOT_FILES.has(entry.name) || PACKAGE_ENTRIES.has(entry.name);
    if (!known) {
      issues.push({
        id: entry.name,
        message: `unexpected ${entry.isDirectory() ? 'folder' : 'file'} in content/ (content folders: ${CONTENT_DIRS.join(', ')}; root files: ${[...ROOT_FILES].join(', ')})`,
      });
    }
  }

  for (const dir of CONTENT_DIRS) {
    const files: string[] = [];
    for (const entry of await entriesOf(join(root, dir))) {
      if (entry.isFile() && entry.name.endsWith('.json')) files.push(entry.name);
      else {
        issues.push({
          id: `${dir}/${entry.name}`,
          message: `only *.json files are allowed directly inside ${dir}/ (no subfolders or other files)`,
        });
      }
    }
    for (const name of files.sort()) {
      const label = `${dir}/${name}`;
      switch (dir) {
        case 'questions': {
          const file = await parse(label, QuestionsFile);
          if (file) bundle.questions.push(...file.questions);
          break;
        }
        case 'stances': {
          const file = await parse(label, StancesFile);
          if (file) bundle.stances.push(...file.stances);
          break;
        }
        case 'interests': {
          const file = await parse(label, InterestsFile);
          if (file) {
            bundle.categories.push(...file.categories);
            bundle.items.push(...file.items);
          }
          break;
        }
        case 'dating': {
          const file = await parse(label, GendersFile);
          if (file) bundle.genders.push(...file.genders);
          break;
        }
        case 'openers': {
          const file = await parse(label, OpenersFile);
          if (file) bundle.openers.push(...file.openers);
          break;
        }
        case 'aliases': {
          const file = await parse(label, AliasesFile);
          if (file) bundle.aliases.push(...file.aliases);
          break;
        }
      }
    }
  }

  const rootFiles = new Set(rootEntries.filter((e) => e.isFile()).map((e) => e.name));
  if (rootFiles.has(PRODUCTS_FILE)) {
    const file = await parse(PRODUCTS_FILE, ProductsFile);
    if (file) bundle.products.push(...file.products);
  }
  if (rootFiles.has(RELEASE_FILE)) {
    bundle.release = await parse(RELEASE_FILE, ReleaseFile);
  } else {
    issues.push({
      id: RELEASE_FILE,
      message: 'is missing: every content root declares its release version',
    });
  }
  const lockFilePresent = rootFiles.has(LOCK_FILE);
  if (lockFilePresent) bundle.lock = await parse(LOCK_FILE, LockFile);

  return { bundle, issues, lockFilePresent };
}
