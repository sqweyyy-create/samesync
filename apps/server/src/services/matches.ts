/**
 * The caller's matches (PLAN.md Phase 2: the Mini App home lists them; the match screen itself is
 * a placeholder until Phase 3). Reads go through the participant-scoped repository, which hides a
 * match closed for a band change and any match whose users' live bands differ from its band.
 * Frozen and deleted accounts can't call this (CLAUDE.md invariant 9).
 */
import type { Locale } from '@samesync/shared';
import type { MatchSummary, MatchesResponse } from '@samesync/shared/api';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Clock } from '../clock';
import { localized, type ContentStore } from '../content/store';
import type { MatchView, MatchesRepository } from '../db/repositories/matches';
import type { UsersRepository } from '../db/repositories/users';
import { parseTeaser, renderTeaser } from '../domain/matching/teaser';
import type { ValidatedInitData } from '../http/auth/init-data';
import { loadCurrentUser } from './current-user';
import { ServiceError } from './errors';

export interface MatchesService {
  list(auth: ValidatedInitData): Promise<MatchesResponse>;
  get(auth: ValidatedInitData, matchId: string): Promise<MatchSummary>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMatchesService(deps: {
  users: UsersRepository;
  matches: MatchesRepository;
  content: ContentStore;
  clock: Clock;
}): MatchesService {
  const { matches, content } = deps;

  async function caller(auth: ValidatedInitData) {
    const user = await loadCurrentUser(deps, auth);
    if (user.status === 'frozen' || user.status === 'deleted') throw new ServiceError('forbidden');
    return user;
  }

  function present(view: MatchView, locale: Locale): MatchSummary {
    const alias = content.alias(view.counterpartAlias);
    return {
      id: view.id,
      alias: {
        emoji: alias?.emoji ?? '👤',
        name: alias ? localized(alias.text, locale) : '—',
      },
      teaser: renderTeaser(
        parseTeaser(view.teaser),
        locale,
        content.teaser,
        translatorFor(locale).t,
      ),
      status: view.status,
      createdAt: view.createdAt.toISOString(),
      gameDeadlineAt: view.gameDeadlineAt.toISOString(),
    };
  }

  return {
    async list(auth) {
      const user = await caller(auth);
      // Only active users have matches; nobody else needs the query.
      if (user.status !== 'active') return { matches: [] };
      const views = await matches.listOpenForParticipant(user.id);
      return { matches: views.map((view) => present(view, user.locale)) };
    },

    async get(auth, matchId) {
      const user = await caller(auth);
      // Not a participant, closed for a band change, or simply unknown: all look the same.
      const view = UUID.test(matchId) ? await matches.getForParticipant(user.id, matchId) : null;
      if (!view) throw new ServiceError('not_found');
      return present(view, user.locale);
    },
  };
}
