/**
 * Messages to the admins (PLAN.md Phase 5, Q30): a report that needs a look at once, an automatic
 * freeze, a support request. Admins are Telegram IDs in the configuration, not necessarily users
 * of the product, so these go straight to the Bot API, each in the admin's own language when the
 * bot knows one. Best effort: a failure is logged and the report or the freeze is on record
 * anyway.
 */
import { SOURCE_LOCALE } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { UsersRepository } from '../db/repositories/users';
import type { Logger } from '../logger';
import { classifyTelegramError } from './telegram-errors';

export interface AdminNotifier {
  /** Whether any admin is configured at all. */
  readonly configured: boolean;
  /** Sends one message to every admin, rendered per admin. Returns how many were reached. */
  notify(render: (t: Translator['t']) => string): Promise<number>;
}

export interface AdminTelegram {
  sendMessage(
    chatId: number,
    text: string,
    options: { link_preview_options: { is_disabled: true } },
  ): Promise<unknown>;
}

export function createAdminNotifier(deps: {
  adminTelegramIds: readonly number[];
  users: Pick<UsersRepository, 'localeOf'>;
  telegram: AdminTelegram;
  logger: Logger;
}): AdminNotifier {
  const ids = [...new Set(deps.adminTelegramIds)];
  return {
    configured: ids.length > 0,
    async notify(render) {
      let reached = 0;
      for (const adminId of ids) {
        const locale = (await deps.users.localeOf(adminId)) ?? SOURCE_LOCALE;
        try {
          await deps.telegram.sendMessage(adminId, render(translatorFor(locale).t), {
            link_preview_options: { is_disabled: true },
          });
          reached++;
        } catch (error) {
          deps.logger.warn(
            { adminId, error: classifyTelegramError(error).detail },
            'admin not reached',
          );
        }
      }
      return reached;
    },
  };
}
