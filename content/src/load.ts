import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { z } from 'zod';
import type { ContentBundle, ContentIssue } from './check';
import { AliasesFile, InterestsFile, OpenersFile, ProductsFile, QuestionsFile } from './schema';

export interface LoadResult {
  bundle: ContentBundle;
  /** Schema and parse problems, keyed by file path instead of content ID. */
  issues: ContentIssue[];
}

async function jsonFilesIn(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => n.endsWith('.json'))
      .sort()
      .map((n) => join(dir, n));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Loads and schema-validates every content file under `root`. */
export async function loadContent(root: string): Promise<LoadResult> {
  const bundle: ContentBundle = {
    questions: [],
    categories: [],
    items: [],
    openers: [],
    aliases: [],
    products: [],
  };
  const issues: ContentIssue[] = [];

  async function parse<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T> | null> {
    const label = relative(root, path);
    let json: unknown;
    try {
      json = JSON.parse(await readFile(path, 'utf8'));
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

  for (const path of await jsonFilesIn(join(root, 'questions'))) {
    const file = await parse(path, QuestionsFile);
    if (file) bundle.questions.push(...file.questions);
  }
  for (const path of await jsonFilesIn(join(root, 'interests'))) {
    const file = await parse(path, InterestsFile);
    if (file) {
      bundle.categories.push(...file.categories);
      bundle.items.push(...file.items);
    }
  }
  for (const path of await jsonFilesIn(join(root, 'openers'))) {
    const file = await parse(path, OpenersFile);
    if (file) bundle.openers.push(...file.openers);
  }
  for (const path of await jsonFilesIn(join(root, 'aliases'))) {
    const file = await parse(path, AliasesFile);
    if (file) bundle.aliases.push(...file.aliases);
  }
  const productsPath = join(root, 'products.json');
  if (await exists(productsPath)) {
    const file = await parse(productsPath, ProductsFile);
    if (file) bundle.products.push(...file.products);
  }

  return { bundle, issues };
}
