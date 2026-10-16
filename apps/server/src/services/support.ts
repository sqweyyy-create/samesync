/**
 * `/support` (PLAN.md Phase 5): a user's text goes to the admins as a message the bot composes,
 * with the user's support code, never their name. A few per hour per user, so that one person
 * can't flood the admins. The text itself is never logged.
 */
import type { Locale } from '@samesync/shared';
import type { Clock } from '../clock';
import type { SafetyParams } from '../domain/safety/params';
import type { Logger } from '../logger';
import type { AdminNotifier } from './admin-alerts';

export interface SupportService {
  request(
    user: { id: string; publicId: string; locale: Locale },
    text: string,
  ): Promise<'sent' | 'too_many' | 'unavailable'>;
}

const HOUR = 3_600_000;

export function createSupportService(deps: {
  notifier: AdminNotifier;
  clock: Clock;
  logger: Logger;
  params: Pick<SafetyParams, 'supportPerHour'>;
}): SupportService {
  /** When each user last wrote, newest last; only the last hour is kept. */
  const recent = new Map<string, number[]>();

  return {
    async request(user, text) {
      const now = deps.clock.now().getTime();
      const mine = (recent.get(user.id) ?? []).filter((at) => now - at < HOUR);
      if (mine.length >= deps.params.supportPerHour) {
        recent.set(user.id, mine);
        return 'too_many';
      }
      if (!deps.notifier.configured) {
        deps.logger.warn({ userId: user.id }, 'support request with no admin configured');
        return 'unavailable';
      }
      const reached = await deps.notifier.notify((t) =>
        t('admin.alert.support', { code: user.publicId, locale: user.locale, text }),
      );
      if (reached === 0) return 'unavailable';
      mine.push(now);
      recent.set(user.id, mine);
      if (recent.size > 10_000) recent.clear();
      deps.logger.info({ userId: user.id, admins: reached }, 'support request sent');
      return 'sent';
    },
  };
}
