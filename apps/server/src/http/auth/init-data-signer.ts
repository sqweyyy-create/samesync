/**
 * DEV AND TEST ONLY. Produces initData signed the way Telegram signs it, for `pnpm dev:initdata`
 * and tests. Runtime code must never import this file (enforced by ESLint).
 */
import { computeInitDataHash } from './init-data';

export interface SignInitDataInput {
  botToken: string;
  authDate: Date;
  user?: Record<string, unknown>;
  /** Extra fields, e.g. query_id or chat_type. Use `rawUser` to sign a deliberately broken user. */
  extra?: Record<string, string>;
  rawUser?: string;
}

export function signInitData(input: SignInitDataInput): string {
  const entries: Array<[string, string]> = [
    ['auth_date', String(Math.floor(input.authDate.getTime() / 1000))],
  ];
  const user = input.rawUser ?? (input.user ? JSON.stringify(input.user) : undefined);
  if (user !== undefined) entries.push(['user', user]);
  for (const [key, value] of Object.entries(input.extra ?? {})) entries.push([key, value]);
  const hash = computeInitDataHash(input.botToken, entries).toString('hex');
  return new URLSearchParams([...entries, ['hash', hash]]).toString();
}
