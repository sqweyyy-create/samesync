/**
 * Reads a user's current Telegram username for a reveal (PLAN.md Phase 4, Q25). The two callers
 * are the reveal service, which only wants to know whether there is one, and the outbox sender,
 * which puts it into the one message that reveals it. Both have checked first that the match is
 * an adult one and that both users consented.
 * A username is never logged and never stored by this module.
 */
export interface Usernames {
  /** Null if the user has no username, or if Telegram can't be asked: then nothing is revealed. */
  current(user: { telegramId: number; synthetic: boolean }): Promise<string | null>;
}

/** The username every synthetic user "has" outside production. Not a real account's by intent. */
export const DEV_SYNTHETIC_USERNAME = 'synthetic_user';

export function createUsernames(deps: {
  /** Bot API `getChat`: the username as it is right now, not as it was when we last saw it. */
  getChat: (chatId: number) => Promise<{ username?: string | undefined }>;
  /**
   * Development only: the username a synthetic user "has", so the reveal can be tried with one
   * Telegram account. Unset in production, where synthetic users are ignored anyway.
   */
  syntheticUsername?: string | undefined;
}): Usernames {
  return {
    async current(user) {
      if (user.synthetic) return deps.syntheticUsername ?? null;
      try {
        const chat = await deps.getChat(user.telegramId);
        return chat.username?.trim() ? chat.username : null;
      } catch {
        return null;
      }
    },
  };
}
