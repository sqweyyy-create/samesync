/**
 * Validation of Telegram Mini App initData, per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = every field except `hash`, sorted by key, as "key=value", joined by "\n"
 *   valid             = hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 *
 * Fails closed: anything unexpected is a rejection (CLAUDE.md safety invariant 10).
 * Only identity from a validated result may be trusted.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export interface InitDataUser {
  id: number;
  firstName: string;
  lastName?: string;
  /** Present in initData, but Phase 0 never stores or returns it (u18 username rule). */
  username?: string;
  languageCode?: string;
  isPremium?: boolean;
  allowsWriteToPm?: boolean;
}

export interface ValidatedInitData {
  user: InitDataUser;
  authDate: Date;
  queryId?: string;
  startParam?: string;
  chatType?: string;
  chatInstance?: string;
}

export type InitDataFailure =
  | 'malformed'
  | 'duplicate_param'
  | 'missing_hash'
  | 'bad_hash'
  | 'missing_auth_date'
  | 'expired'
  | 'from_future'
  | 'missing_user'
  | 'bad_user';

export type InitDataResult =
  { ok: true; data: ValidatedInitData } | { ok: false; reason: InitDataFailure };

export interface InitDataOptions {
  botToken: string;
  now: Date;
  /** Oldest acceptable `auth_date`, in seconds. */
  maxAgeSec: number;
  /** How far `auth_date` may be ahead of our clock, in seconds. */
  clockSkewSec: number;
}

const MAX_RAW_LENGTH = 8192;

const UserSchema = z.object({
  id: z.int().positive(),
  first_name: z.string().max(256),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  language_code: z.string().max(35).optional(),
  is_premium: z.boolean().optional(),
  allows_write_to_pm: z.boolean().optional(),
});

/** HMAC over the data-check string, as raw bytes. Exported for the dev/test signer only. */
export function computeInitDataHash(
  botToken: string,
  entries: ReadonlyArray<[string, string]>,
): Buffer {
  const dataCheckString = entries
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  return createHmac('sha256', secretKey).update(dataCheckString).digest();
}

const fail = (reason: InitDataFailure): InitDataResult => ({ ok: false, reason });

export function validateInitData(raw: string, options: InitDataOptions): InitDataResult {
  if (raw.length === 0 || raw.length > MAX_RAW_LENGTH) return fail('malformed');

  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [key, value] of new URLSearchParams(raw)) {
    if (seen.has(key)) return fail('duplicate_param');
    seen.add(key);
    entries.push([key, value]);
  }
  const fields = new Map(entries);

  const hash = fields.get('hash');
  if (hash === undefined) return fail('missing_hash');
  if (!/^[0-9a-f]{64}$/.test(hash)) return fail('bad_hash');
  const expected = computeInitDataHash(options.botToken, entries);
  if (!timingSafeEqual(Buffer.from(hash, 'hex'), expected)) return fail('bad_hash');

  // Signature is valid; now interpret the fields.
  const authDateRaw = fields.get('auth_date');
  if (authDateRaw === undefined || !/^\d{1,12}$/.test(authDateRaw))
    return fail('missing_auth_date');
  const authDateSec = Number(authDateRaw);
  const nowSec = Math.floor(options.now.getTime() / 1000);
  if (nowSec - authDateSec > options.maxAgeSec) return fail('expired');
  if (authDateSec - nowSec > options.clockSkewSec) return fail('from_future');

  const userRaw = fields.get('user');
  if (userRaw === undefined) return fail('missing_user');
  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw);
  } catch {
    return fail('bad_user');
  }
  const parsedUser = UserSchema.safeParse(userJson);
  if (!parsedUser.success) return fail('bad_user');
  const u = parsedUser.data;

  const user: InitDataUser = { id: u.id, firstName: u.first_name };
  if (u.last_name !== undefined) user.lastName = u.last_name;
  if (u.username !== undefined) user.username = u.username;
  if (u.language_code !== undefined) user.languageCode = u.language_code;
  if (u.is_premium !== undefined) user.isPremium = u.is_premium;
  if (u.allows_write_to_pm !== undefined) user.allowsWriteToPm = u.allows_write_to_pm;

  const data: ValidatedInitData = { user, authDate: new Date(authDateSec * 1000) };
  const optional = {
    queryId: 'query_id',
    startParam: 'start_param',
    chatType: 'chat_type',
    chatInstance: 'chat_instance',
  } as const;
  for (const [prop, key] of Object.entries(optional) as Array<[keyof typeof optional, string]>) {
    const value = fields.get(key);
    if (value !== undefined) data[prop] = value;
  }
  return { ok: true, data };
}
