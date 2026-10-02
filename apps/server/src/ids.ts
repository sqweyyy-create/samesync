import { randomBytes } from 'node:crypto';

/** Crockford base32 without I, L, O, U, so support codes are easy to read aloud. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PUBLIC_ID_LENGTH = 10;

/** A short support code shown to the user and to admins (never a telegram_id). */
export function newPublicId(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(PUBLIC_ID_LENGTH);
  let id = '';
  for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
  return id;
}
