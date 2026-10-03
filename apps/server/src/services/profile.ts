/**
 * Onboarding and profile settings for the calling user (PLAN.md Phase 1). Every method takes the
 * validated initData and only ever touches that user's own data.
 *
 * Safety: the band is always computed from the birth date at call time (never from the cached
 * age_band); u18 users are friends-only; the birth date is write-once; usernames are stored for
 * live adults only (repository + DB CHECK).
 */
import { DOMAINS, type Domain } from '@samesync/content';
import {
  ageOn,
  bandFor,
  birthDateProblem,
  defaultDatingAgeRange,
  utcDate,
  type Band,
  type Locale,
} from '@samesync/shared';
import {
  ONBOARDING,
  type AnswerValue,
  type CompleteRequest,
  type DatingOptionsResponse,
  type DeckResponse,
  type InterestsResponse,
  type MeResponse,
  type SetModeRequest,
} from '@samesync/shared/api';
import type { Clock } from '../clock';
import { localized, type ContentStore } from '../content/store';
import type { ProfileRepository } from '../db/repositories/profile';
import type { UserRecord, UsersRepository } from '../db/repositories/users';
import { drawDeck, isValidTimezone, nextStep } from '../domain/onboarding';
import type { ValidatedInitData } from '../http/auth/init-data';
import { loadCurrentUser } from './current-user';
import { ServiceError } from './errors';

export interface ProfileServiceDeps {
  users: UsersRepository;
  profile: ProfileRepository;
  content: ContentStore;
  clock: Clock;
  /** While false, u18 users finish onboarding as `waitlisted` (CLAUDE.md invariant 12). */
  u18PoolEnabled: boolean;
}

export interface ProfileService {
  me(auth: ValidatedInitData): Promise<MeResponse>;
  setLocale(auth: ValidatedInitData, locale: Locale): Promise<MeResponse>;
  setBirthDate(auth: ValidatedInitData, birthDate: string): Promise<MeResponse>;
  setMode(auth: ValidatedInitData, request: SetModeRequest): Promise<MeResponse>;
  datingOptions(auth: ValidatedInitData): Promise<DatingOptionsResponse>;
  deck(auth: ValidatedInitData): Promise<DeckResponse>;
  saveAnswers(
    auth: ValidatedInitData,
    answers: ReadonlyArray<{ questionId: string; value: AnswerValue }>,
  ): Promise<MeResponse>;
  interests(
    auth: ValidatedInitData,
    filter: { domain?: string; q?: string },
  ): Promise<InterestsResponse>;
  saveInterests(auth: ValidatedInitData, itemIds: readonly string[]): Promise<MeResponse>;
  complete(auth: ValidatedInitData, request: CompleteRequest): Promise<MeResponse>;
}

export function createProfileService(deps: ProfileServiceDeps): ProfileService {
  const { users, profile, content, clock } = deps;
  const today = () => utcDate(clock.now());

  /** Live band from the birth date; null without a birth date or below 14. */
  const bandOf = (user: UserRecord): Band | null =>
    user.birthDate ? bandFor(ageOn(user.birthDate, today())) : null;

  const load = (auth: ValidatedInitData) => loadCurrentUser({ users, clock }, auth);

  /** Frozen and deleted accounts can read their own state but change nothing (invariant 9). */
  function assertCanAct(user: UserRecord): void {
    if (user.status === 'frozen' || user.status === 'deleted') throw new ServiceError('forbidden');
  }

  /** The band and, for deck and catalog work, the mode; otherwise the step is out of order. */
  function requireBand(user: UserRecord): Band {
    if (!user.birthDate) throw new ServiceError('out_of_order', ['birth_date']);
    const band = bandOf(user);
    if (!band || user.status === 'ineligible') throw new ServiceError('forbidden', ['ineligible']);
    return band;
  }
  function requireDeckScope(user: UserRecord) {
    const band = requireBand(user);
    if (!user.mode) throw new ServiceError('out_of_order', ['mode']);
    return { band, mode: user.mode, locale: user.locale };
  }

  async function present(auth: ValidatedInitData, user: UserRecord): Promise<MeResponse> {
    const band = bandOf(user);
    const deckIds =
      band && user.mode
        ? content.deckCandidates({ band, mode: user.mode, locale: user.locale }).map((q) => q.id)
        : [];
    const answered = deckIds.length > 0 ? await profile.countAnswered(user.id, deckIds) : 0;
    const interests = band
      ? (await profile.interestsOf(user.id)).filter((id) =>
          content.isItemAvailable(id, { band, locale: user.locale }),
        ).length
      : 0;
    const step = nextStep({
      status: user.status,
      localeConfirmed: user.localeConfirmedAt !== null,
      birthDate: user.birthDate,
      band,
      mode: user.mode,
      answered,
      interests,
      onboarded: user.onboardedAt !== null,
    });
    return {
      publicId: user.publicId,
      firstName: auth.user.firstName,
      locale: user.locale,
      status: user.status,
      step,
      birthDate: user.birthDate,
      age: user.birthDate ? ageOn(user.birthDate, today()) : null,
      band,
      mode: user.mode,
      gender: user.gender,
      seeking: user.seeking,
      datingAgeMin: user.datingAgeMin,
      datingAgeMax: user.datingAgeMax,
      progress: { answered, interests },
    };
  }

  return {
    async me(auth) {
      return present(auth, await load(auth));
    },

    async setLocale(auth, locale) {
      const user = await load(auth);
      assertCanAct(user);
      return present(auth, await users.confirmLocale(user.id, locale, clock.now()));
    },

    async setBirthDate(auth, birthDate) {
      const user = await load(auth);
      assertCanAct(user);
      if (!user.localeConfirmedAt) throw new ServiceError('out_of_order', ['locale']);
      if (user.birthDate) throw new ServiceError('conflict', ['birth_date_already_set']);
      const problem = birthDateProblem(birthDate, today());
      if (problem) throw new ServiceError('invalid', [problem]);
      const band = bandFor(ageOn(birthDate, today()));
      const updated = await users.setBirthDateOnce(user.id, {
        birthDate,
        // Under 14 (Q16): only the birth date and the status are kept.
        status: band ? user.status : 'ineligible',
        // u18 is friends-only, so the mode is decided right away.
        mode: band === 'u18' ? 'friends' : null,
      });
      if (!updated) throw new ServiceError('conflict', ['birth_date_already_set']);
      return present(auth, updated);
    },

    async setMode(auth, { mode, gender, seeking, ageMin, ageMax }) {
      const user = await load(auth);
      assertCanAct(user);
      const band = requireBand(user);
      if (mode === 'friends') {
        if ([gender, seeking, ageMin, ageMax].some((field) => field !== undefined)) {
          throw new ServiceError('invalid', ['friends mode takes no dating fields']);
        }
        return present(
          auth,
          await users.setMode(user.id, { mode, gender: null, seeking: null, datingAge: null }),
        );
      }
      if (band !== 'adult') throw new ServiceError('forbidden', ['dating is for adults only']);
      const problems: string[] = [];
      if (!gender || !content.isDatingOption(gender)) problems.push('gender');
      if (
        !seeking ||
        seeking.length === 0 ||
        new Set(seeking).size !== seeking.length ||
        !seeking.every((id) => content.isDatingOption(id))
      ) {
        problems.push('seeking');
      }
      // Q12: an explicit range needs both ends; otherwise keep the stored one or use the default.
      const explicit = ageMin !== undefined || ageMax !== undefined;
      if (explicit && (ageMin === undefined || ageMax === undefined || ageMin > ageMax)) {
        problems.push('age_range');
      }
      if (problems.length > 0) throw new ServiceError('invalid', problems);
      const stored =
        user.datingAgeMin !== null && user.datingAgeMax !== null
          ? { min: user.datingAgeMin, max: user.datingAgeMax }
          : null;
      const datingAge = explicit
        ? { min: ageMin!, max: ageMax! }
        : (stored ?? defaultDatingAgeRange(ageOn(user.birthDate!, today())));
      return present(
        auth,
        await users.setMode(user.id, { mode, gender: gender!, seeking: seeking!, datingAge }),
      );
    },

    async datingOptions(auth) {
      const user = await load(auth);
      if (requireBand(user) !== 'adult')
        throw new ServiceError('forbidden', ['dating is for adults only']);
      return {
        options: content.datingOptions().map((o) => ({
          id: o.id,
          self: localized(o.self, user.locale),
          seeking: localized(o.seeking, user.locale),
        })),
      };
    },

    async deck(auth) {
      const user = await load(auth);
      assertCanAct(user);
      const scope = requireDeckScope(user);
      const candidates = content.deckCandidates(scope);
      const byId = new Map(candidates.map((q) => [q.id, q]));
      const ids = drawDeck([...byId.keys()], user.id, ONBOARDING.deckSize);
      const answers = await profile.answersOf(user.id);
      return {
        questions: ids.map((id) => ({ id, text: localized(byId.get(id)!.text, user.locale) })),
        answers: ids
          .filter((id) => answers.has(id))
          .map((id) => ({ questionId: id, value: answers.get(id)! })),
      };
    },

    async saveAnswers(auth, entries) {
      const user = await load(auth);
      assertCanAct(user);
      const scope = requireDeckScope(user);
      const ids = entries.map((e) => e.questionId);
      if (new Set(ids).size !== ids.length)
        throw new ServiceError('invalid', ['duplicate question']);
      // Unknown, retired, or outside the user's band/mode/locale (e.g. adult-only takes for u18).
      const unavailable = ids.filter((id) => !content.isQuestionAvailable(id, scope));
      if (unavailable.length > 0) throw new ServiceError('invalid', unavailable);
      await profile.saveAnswers(user.id, entries, content.release, clock.now());
      return present(auth, user);
    },

    async interests(auth, { domain, q }) {
      const user = await load(auth);
      assertCanAct(user);
      const band = requireBand(user);
      if (domain !== undefined && !(DOMAINS as readonly string[]).includes(domain)) {
        throw new ServiceError('invalid', ['domain']);
      }
      const scope = { band, locale: user.locale };
      const found = content.searchCatalog(scope, {
        ...(domain ? { domain: domain as Domain } : {}),
        ...(q ? { q } : {}),
      });
      const selected = (await profile.interestsOf(user.id)).filter((id) =>
        content.isItemAvailable(id, scope),
      );
      return {
        items: found.map(({ item, category }) => ({
          id: item.id,
          name: localized(item.name, user.locale),
          categoryName: localized(category.name, user.locale),
          domain: category.domain,
        })),
        selected,
      };
    },

    async saveInterests(auth, itemIds) {
      const user = await load(auth);
      assertCanAct(user);
      const band = requireBand(user);
      if (!user.mode) throw new ServiceError('out_of_order', ['mode']);
      if (new Set(itemIds).size !== itemIds.length)
        throw new ServiceError('invalid', ['duplicate item']);
      if (itemIds.length > ONBOARDING.maxInterests)
        throw new ServiceError('invalid', ['too many items']);
      // During onboarding the deck comes first (steps can't run out of order).
      if (!user.onboardedAt) {
        const state = await present(auth, user);
        if (state.step === 'answers') throw new ServiceError('out_of_order', ['answers']);
      }
      const unavailable = itemIds.filter(
        (id) => !content.isItemAvailable(id, { band, locale: user.locale }),
      );
      if (unavailable.length > 0) throw new ServiceError('invalid', unavailable);
      await profile.replaceInterests(user.id, itemIds, clock.now());
      return present(auth, user);
    },

    async complete(auth, { timezone }) {
      const user = await load(auth);
      assertCanAct(user);
      const state = await present(auth, user);
      if (state.step === 'done') return state;
      if (state.step !== 'finish') throw new ServiceError('out_of_order', [state.step]);
      if (timezone !== undefined && !isValidTimezone(timezone))
        throw new ServiceError('invalid', ['timezone']);
      const status = state.band === 'u18' && !deps.u18PoolEnabled ? 'waitlisted' : 'active';
      return present(
        auth,
        await users.complete(user.id, { status, timezone: timezone ?? null, now: clock.now() }),
      );
    },
  };
}
