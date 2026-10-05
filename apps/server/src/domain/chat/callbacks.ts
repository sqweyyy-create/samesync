/**
 * The data of the bot's inline buttons for the chat. Telegram hands it back as it was sent, but a
 * client can send anything, so it is validated like every other input (CLAUDE.md: zod at every
 * boundary). It only ever names an action and a match: whether the user may do that to that match
 * is decided by the services, from the database.
 */
import { z } from 'zod';

export const CHAT_ACTIONS = [
  /** "Write here": makes the chat the active one. */
  'to',
  /** The picker: sends the message it hangs under to this chat. */
  'send',
  /** Asks whether to leave this chat; `leave_yes` does it. */
  'leave',
  'leave_yes',
  /** Asks whether to reveal usernames in this chat; `reveal_yes` consents, `reveal_no` doesn't. */
  'reveal',
  'reveal_yes',
  'reveal_no',
  /** Puts the question away. */
  'cancel',
] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

export interface ChatCallback {
  action: ChatAction;
  matchId: string;
}

const PREFIX = 'c';
const Callback = z.object({ action: z.enum(CHAT_ACTIONS), matchId: z.uuid() });

/** At most 49 bytes: Telegram allows 64. */
export function encodeCallback(action: ChatAction, matchId: string): string {
  return `${PREFIX}:${action}:${matchId}`;
}

/** Null for anything that is not exactly one of our buttons. */
export function parseCallback(data: string | undefined): ChatCallback | null {
  if (data === undefined || data.length > 64) return null;
  const [prefix, action, matchId, ...rest] = data.split(':');
  if (prefix !== PREFIX || rest.length > 0) return null;
  const parsed = Callback.safeParse({ action, matchId });
  return parsed.success ? parsed.data : null;
}
