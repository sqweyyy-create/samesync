/**
 * Button data of the admin confirmations and of the account commands. Like the chat buttons
 * (domain/chat/callbacks.ts), the data is validated and names an action only: who may do it is
 * decided by the handlers, from the allowlist and the database, on every press.
 *
 * An admin confirmation carries no arguments: the question is a reply to the admin's own command,
 * and the handler reads the command again from that message. The short hash of the command text
 * in the data makes a button under an edited or unrelated message useless.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const ADMIN_PREFIX = 'a';
export const ACCOUNT_PREFIX = 'u';

export const ADMIN_ACTIONS = ['confirm', 'cancel'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export const ACCOUNT_ACTIONS = ['delete_yes', 'delete_no'] as const;
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number];

const HASH_LENGTH = 12;

/** A short, stable fingerprint of a command text. */
export function commandHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex').slice(0, HASH_LENGTH);
}

const AdminCallback = z.object({
  action: z.enum(ADMIN_ACTIONS),
  hash: z.string().regex(new RegExp(`^[0-9a-f]{${HASH_LENGTH}}$`)),
});
const AccountCallback = z.object({ action: z.enum(ACCOUNT_ACTIONS) });

export function encodeAdminCallback(action: AdminAction, commandText: string): string {
  return `${ADMIN_PREFIX}:${action}:${commandHash(commandText)}`;
}

export function parseAdminCallback(
  data: string | undefined,
): { action: AdminAction; hash: string } | null {
  if (data === undefined || data.length > 64) return null;
  const [prefix, action, hash, ...rest] = data.split(':');
  if (prefix !== ADMIN_PREFIX || rest.length > 0) return null;
  const parsed = AdminCallback.safeParse({ action, hash });
  return parsed.success ? parsed.data : null;
}

export function encodeAccountCallback(action: AccountAction): string {
  return `${ACCOUNT_PREFIX}:${action}`;
}

export function parseAccountCallback(data: string | undefined): { action: AccountAction } | null {
  if (data === undefined || data.length > 64) return null;
  const [prefix, action, ...rest] = data.split(':');
  if (prefix !== ACCOUNT_PREFIX || rest.length > 0) return null;
  const parsed = AccountCallback.safeParse({ action });
  return parsed.success ? parsed.data : null;
}
