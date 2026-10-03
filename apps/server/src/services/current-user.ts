import { MIN_AGE, ageOn, resolveLocale, utcDate } from '@samesync/shared';
import type { Clock } from '../clock';
import type { UserRecord, UsersRepository } from '../db/repositories/users';
import type { ValidatedInitData } from '../http/auth/init-data';

/**
 * The caller's own row for an API request, identified only by validated initData. Created on
 * first contact; every call also does the small upkeep that depends on "now":
 * - Q16: an ineligible user who has turned 14 continues onboarding;
 * - the username is refreshed for live adults only (checked in SQL, CLAUDE.md invariant 6);
 * - a user whose initData says the bot may write to them is reachable again.
 */
export async function loadCurrentUser(
  deps: { users: UsersRepository; clock: Clock },
  auth: ValidatedInitData,
): Promise<UserRecord> {
  const { users, clock } = deps;
  let user = await users.upsertOnAuth({
    telegramId: auth.user.id,
    locale: resolveLocale(auth.user.languageCode),
    now: clock.now(),
  });
  if (
    user.status === 'ineligible' &&
    user.birthDate &&
    ageOn(user.birthDate, utcDate(clock.now())) >= MIN_AGE
  ) {
    user = (await users.reopenIfFourteen(user.id)) ?? user;
  }
  await users.storeUsernameIfAdult(auth.user.id, auth.user.username ?? null);
  if (auth.user.allowsWriteToPm === true) await users.setBotReachable(auth.user.id, true);
  return user;
}
