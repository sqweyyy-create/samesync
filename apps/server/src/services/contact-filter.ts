/**
 * The contact filter as the relay runs it (PLAN.md Phase 5): the pure detector over the message
 * and over the sender's last messages in that chat, so that a contact split across messages is
 * caught. Any error ends in the screening hook, which then refuses the message.
 */
import type { ChatRepository } from '../db/repositories/chat';
import type { ContactFilter } from '../domain/chat/relay';
import { findContactInWindow } from '../domain/safety/contact-filter';
import type { SafetyParams } from '../domain/safety/params';

export function createContactFilter(deps: {
  chat: Pick<ChatRepository, 'recentTexts'>;
  params: Pick<SafetyParams, 'filterRecentMessages'>;
}): ContactFilter {
  return async ({ text, matchId, senderId }) => {
    const recent = await deps.chat.recentTexts(senderId, matchId, deps.params.filterRecentMessages);
    const kind = findContactInWindow(recent, text);
    return kind ? { hit: true, kind } : { hit: false };
  };
}
