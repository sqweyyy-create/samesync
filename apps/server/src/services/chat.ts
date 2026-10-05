/**
 * What a user does with their chats besides writing in them (PLAN.md Phase 4): look at the list,
 * choose where plain messages go, leave, and send the first message from the Mini App.
 *
 * Safety: a chat is only ever one the relay lists for that user (open, both live bands equal to
 * the band of the match, in a band that can chat), and the other person appears under their alias
 * only. The first message from the Mini App goes through the relay like any other message.
 * Frozen and deleted accounts can't call the API (CLAUDE.md invariant 9).
 */
import type { MatchSummary } from '@samesync/shared/api';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Clock } from '../clock';
import { aliasText, type ContentStore } from '../content/store';
import type { ChatRepository, ChatUser } from '../db/repositories/chat';
import type { MatchesRepository } from '../db/repositories/matches';
import type { UsersRepository } from '../db/repositories/users';
import { relayText } from '../domain/chat/relay';
import type { ValidatedInitData } from '../http/auth/init-data';
import type { Logger } from '../logger';
import { loadCurrentUser } from './current-user';
import { ServiceError } from './errors';
import { UUID, presentMatch } from './matches';
import type { ChatRef, RelayRefusedReason, RelayService, RelayTelegram } from './relay';
import { classifyTelegramError } from './telegram-errors';

export interface ChatService {
  /** The user's open chats, and which of them plain messages go to. */
  overview(user: ChatUser): Promise<{ chats: ChatRef[]; activeMatchId: string | null }>;
  /** "Write here". Null if it is not one of the user's open chats. */
  writeHere(user: ChatUser, matchId: string): Promise<ChatRef | null>;
  /** Ends a chat for both. Null if it is not one of the user's open chats. */
  leave(user: ChatUser, matchId: string): Promise<ChatRef | null>;
  /** `POST /api/matches/:id/messages`: a message written in the Mini App (the opener). */
  sendFromApp(auth: ValidatedInitData, matchId: string, text: string): Promise<MatchSummary>;
}

/** How a refusal of the relay looks to the Mini App. */
const API_ERROR: Record<RelayRefusedReason, ServiceError['code']> = {
  not_text: 'invalid',
  empty: 'invalid',
  too_long: 'invalid',
  rate_limited: 'rate_limited',
  not_found: 'not_found',
  chat_not_open: 'conflict',
  chat_ended: 'conflict',
  band_mismatch: 'not_found',
  blocked: 'conflict',
  recipient_not_active: 'conflict',
  sender_not_active: 'forbidden',
  u18_chat_closed: 'forbidden',
  locale_mismatch: 'conflict',
  screened: 'forbidden',
  not_delivered: 'unavailable',
};

export function createChatService(deps: {
  users: UsersRepository;
  matches: MatchesRepository;
  chat: ChatRepository;
  relay: RelayService;
  telegram: RelayTelegram;
  content: ContentStore;
  clock: Clock;
  logger: Logger;
}): ChatService {
  const { chat, relay, matches, content, clock, logger } = deps;

  async function openChat(user: ChatUser, matchId: string): Promise<ChatRef | null> {
    if (user.status !== 'active') return null;
    const chats = await relay.chatsOf(user);
    return chats.find((c) => c.matchId === matchId) ?? null;
  }

  return {
    async overview(user) {
      const chats = user.status === 'active' ? await relay.chatsOf(user) : [];
      const active = chats.some((c) => c.matchId === user.activeMatchId);
      return { chats, activeMatchId: active ? user.activeMatchId : null };
    },

    async writeHere(user, matchId) {
      const ref = await openChat(user, matchId);
      if (ref) await chat.setActiveMatch(user.id, matchId);
      return ref;
    },

    async leave(user, matchId) {
      const ref = await openChat(user, matchId);
      if (!ref) return null;
      if (!(await chat.leave(user.id, matchId, clock.now()))) return null;
      logger.info({ userId: user.id, matchId }, 'chat left');
      return ref;
    },

    async sendFromApp(auth, matchId, text) {
      const user = await loadCurrentUser(deps, auth);
      if (user.status === 'frozen' || user.status === 'deleted')
        throw new ServiceError('forbidden');
      // Not a participant, closed for a band change, or simply unknown: all look the same.
      if (!UUID.test(matchId)) throw new ServiceError('not_found');
      const result = await relay.send({
        senderId: user.id,
        content: { text, hasEntities: false },
        tgMessageId: null,
        matchId,
      });
      if (result.status === 'refused') {
        // A match that isn't readable for the caller (closed for a band change, or never
        // theirs) answers like the other endpoints of a match do: it does not exist.
        const readable = await matches.getForParticipant(user.id, matchId);
        throw new ServiceError(readable ? API_ERROR[result.reason] : 'not_found');
      }
      // With an explicit match the relay never asks and never finds a duplicate.
      if (result.status !== 'delivered') throw new ServiceError('conflict');

      // The sender's bot chat gets a copy, so the conversation that continues there has its
      // first line, and a reply to the copy is routed to this chat.
      try {
        const { t } = translatorFor(user.locale);
        const header = t('bot.chat.you_to', {
          alias: aliasText(content, result.alias, user.locale),
        });
        const copy = await deps.telegram.sendMessage(auth.user.id, relayText(header, text), {
          link_preview_options: { is_disabled: true },
        });
        await chat.setSenderMessage(result.messageId, copy.message_id);
      } catch (error) {
        // The message itself is delivered; only the copy is missing.
        logger.warn(
          { userId: user.id, matchId, error: classifyTelegramError(error).detail },
          'copy of a Mini App message not sent',
        );
      }

      const view = await matches.getForParticipant(user.id, matchId);
      if (!view) throw new ServiceError('not_found');
      return presentMatch(view, user.locale, content);
    },
  };
}
