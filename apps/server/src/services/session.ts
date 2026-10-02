import { resolveLocale } from '@samesync/shared';
import type { MeResponse } from '@samesync/shared/api';
import type { Clock } from '../clock';
import type { UsersRepository } from '../db/repositories/users';
import type { ValidatedInitData } from '../http/auth/init-data';

export interface SessionService {
  /** The caller's own profile summary, creating the user on first contact. */
  me(auth: ValidatedInitData): Promise<MeResponse>;
}

export function createSessionService(deps: {
  users: UsersRepository;
  clock: Clock;
}): SessionService {
  return {
    async me(auth) {
      const user = await deps.users.upsertOnAuth({
        telegramId: auth.user.id,
        locale: resolveLocale(auth.user.languageCode),
        now: deps.clock.now(),
      });
      return { publicId: user.publicId, firstName: auth.user.firstName, locale: user.locale };
    },
  };
}
