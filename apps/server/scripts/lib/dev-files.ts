/**
 * Where the local dev tooling keeps its files: `.dev/` at the repository root (gitignored, owner
 * only). `dev-up.json` records what `pnpm dev:up` started, so `pnpm dev:down` can stop it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
export const DEV_DIR = join(REPO_ROOT, '.dev');
export const DEV_FILES = {
  env: join(REPO_ROOT, '.env'),
  envBackup: join(DEV_DIR, 'env.backup'),
  tunnelLog: join(DEV_DIR, 'cloudflared.log'),
  state: join(DEV_DIR, 'dev-up.json'),
} as const;

const Pid = z.number().int().positive();
const State = z.object({
  /** The dev:up process itself. */
  pid: Pid,
  /** `pnpm dev`, the leader of its own process group. */
  devPid: z.nullable(Pid),
  tunnelPid: z.nullable(Pid),
  tunnelUrl: z.nullable(z.string()),
  startedAt: z.string(),
});
export type DevUpState = z.infer<typeof State>;

export function ensureDevDir(): void {
  mkdirSync(DEV_DIR, { recursive: true, mode: 0o700 });
}

export function readState(path: string = DEV_FILES.state): DevUpState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = State.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeState(state: DevUpState, path: string = DEV_FILES.state): void {
  ensureDevDir();
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function removeState(path: string = DEV_FILES.state): void {
  rmSync(path, { force: true });
}
