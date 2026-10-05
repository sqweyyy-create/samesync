/**
 * The repository's root .env, for the local dev tooling. A value is read only by the code that
 * needs it and is never printed, logged or copied anywhere: the one exception is the backup that
 * `pnpm dev:up` keeps in .dev/ (gitignored, readable by the owner only) before it changes a line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseEnv } from 'node:util';

/** All values of an env file, parsed like `node --env-file`; empty if there is no file. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
}

/**
 * Sets `key` to `value` in the text of an env file. Only the lines that assign `key` change (an
 * `export ` prefix is kept), every other byte stays as it was, line endings included. A missing
 * key is appended as one new line. Commented-out lines are left alone.
 */
export function replaceEnvValue(
  content: string,
  key: string,
  value: string,
): { content: string; replaced: number } {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('not an env variable name');
  if (/[\r\n]/.test(value)) throw new Error('an env value must fit on one line');
  let replaced = 0;
  const line = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)${key}[ \\t]*=[^\\r\\n]*`, 'gm');
  const next = content.replace(line, (_whole, prefix: string) => {
    replaced++;
    return `${prefix}${key}=${value}`;
  });
  if (replaced > 0) return { content: next, replaced };
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = content === '' || content.endsWith('\n') ? '' : newline;
  return { content: `${content}${separator}${key}=${value}${newline}`, replaced: 0 };
}

/**
 * Changes one variable of an env file in place. The file as it was is saved to `backupPath`
 * first (owner-only permissions), and the new file replaces the old one in a single rename, with
 * the same permissions. Nothing happens when the value is already set.
 */
export async function updateEnvFile(input: {
  envPath: string;
  backupPath: string;
  key: string;
  value: string;
}): Promise<{ changed: boolean }> {
  const original = await readFile(input.envPath, 'utf8');
  const { content } = replaceEnvValue(original, input.key, input.value);
  if (content === original) return { changed: false };
  const mode = (await stat(input.envPath)).mode & 0o777;
  await mkdir(dirname(input.backupPath), { recursive: true, mode: 0o700 });
  await writeFile(input.backupPath, original, { mode: 0o600 });
  await chmod(input.backupPath, 0o600);
  const temporary = `${input.envPath}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, input.envPath);
  return { changed: true };
}

/**
 * Whether Vite's `server.allowedHosts` lets `host` in: an entry that starts with a dot allows the
 * domain and every subdomain of it, any other entry only that exact host.
 */
export function hostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  const wanted = host.toLowerCase();
  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    if (allowed.startsWith('.')) return wanted === allowed.slice(1) || wanted.endsWith(allowed);
    return wanted === allowed;
  });
}
