/**
 * Account deletion (PLAN.md Phase 5, Q23 provisional): one call to `user_delete_account()`,
 * which anonymizes the profile, removes the answers and interests, and sets the status that makes
 * the database close every open match and cancel every pending notification. Reports and audit
 * rows stay. The birth date and the Telegram ID stay too: nobody starts over with another date.
 */
import type { AdminRepository } from '../db/repositories/admin';
import type { Logger } from '../logger';

export interface AccountService {
  deleteAccount(userId: string): Promise<'deleted' | 'already'>;
}

export function createAccountService(deps: {
  admin: Pick<AdminRepository, 'deleteAccount'>;
  logger: Logger;
}): AccountService {
  return {
    async deleteAccount(userId) {
      const deleted = await deps.admin.deleteAccount(userId);
      if (deleted) deps.logger.info({ userId }, 'account deleted');
      return deleted ? 'deleted' : 'already';
    },
  };
}
