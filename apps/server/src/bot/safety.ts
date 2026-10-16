/**
 * Report, block, support and account deletion in the bot (PLAN.md Phase 5). The handlers stay
 * thin: who may report or block whom is decided by the safety service and the database, from
 * the match the button or command names.
 *
 * Safety:
 * - Everything said here names the other person by alias only; a report or a block never tells
 *   them anything but the neutral "this chat has ended" (through the outbox).
 * - Button data is validated (domain/chat/callbacks.ts, domain/safety/callbacks.ts) and names an
 *   action and a match, nothing else; a forged button for someone else's match is "unavailable".
 * - /support sends the admins the user's support code and text, never a name or a username.
 */
import type { ChatTypeContext, Composer, Context } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import type { Locale } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { aliasText, type ContentStore } from '../content/store';
import type { ChatRepository, ChatUser } from '../db/repositories/chat';
import { encodeCallback, parseCallback, type ChatAction } from '../domain/chat/callbacks';
import { encodeAccountCallback, parseAccountCallback } from '../domain/safety/callbacks';
import {
  REPORT_ACTIONS,
  actionOfReason,
  isReportAction,
  REPORT_REASONS,
} from '../domain/safety/reports';
import type { AccountService } from '../services/account';
import type { ChatService } from '../services/chat';
import type { ChatRef } from '../services/relay';
import type { SafetyService } from '../services/safety';
import type { SupportService } from '../services/support';

export interface SafetyBotDeps {
  chat: Pick<ChatRepository, 'user'>;
  chats: Pick<ChatService, 'overview'>;
  safety: Pick<SafetyService, 'report' | 'block' | 'counterpart'>;
  support: SupportService;
  account: AccountService;
  content: ContentStore;
}

type T = Translator['t'];
type ChatContext = ChatTypeContext<Context & { t: T; locale: Locale }, 'private'>;
type Keyboard = InlineKeyboardButton[][];

const SAFETY_ACTIONS = /^c:(?:report|rep_[a-z]+|block|block_yes):/;

/** The longest text /support passes on. */
export const SUPPORT_MAX_LENGTH = 1000;

export function registerSafety(dm: Composer<ChatContext>, deps: SafetyBotDeps): void {
  const alias = (ctx: ChatContext, aliasId: string) => aliasText(deps.content, aliasId, ctx.locale);

  /** Rewrites the message a button hangs under; an old message that can't be edited gets a reply. */
  async function edit(ctx: ChatContext, text: string, keyboard?: Keyboard): Promise<void> {
    const markup = keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {};
    try {
      await ctx.editMessageText(text, markup);
    } catch {
      await ctx.reply(text, markup);
    }
  }
  const say = (ctx: ChatContext, how: 'reply' | 'edit', text: string, keyboard?: Keyboard) =>
    how === 'edit'
      ? edit(ctx, text, keyboard)
      : ctx.reply(text, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});

  const chatButtons = (ctx: ChatContext, chats: readonly ChatRef[], action: ChatAction): Keyboard =>
    chats.map((c) => [
      { text: alias(ctx, c.alias), callback_data: encodeCallback(action, c.matchId) },
    ]);
  const cancelRow = (ctx: ChatContext, matchId: string): InlineKeyboardButton[] => [
    { text: ctx.t('bot.cancel'), callback_data: encodeCallback('cancel', matchId) },
  ];

  /** The reasons, two per row, and a way out. */
  const reasonKeyboard = (ctx: ChatContext, matchId: string): Keyboard => {
    const buttons = REPORT_REASONS.map((reason) => ({
      text: ctx.t(`report.reason.${reason}`),
      callback_data: encodeCallback(actionOfReason(reason), matchId),
    }));
    const rows: Keyboard = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    rows.push(cancelRow(ctx, matchId));
    return rows;
  };

  async function askReason(
    ctx: ChatContext,
    user: ChatUser,
    matchId: string,
    how: 'reply' | 'edit',
  ) {
    const other = await deps.safety.counterpart(user.id, matchId);
    if (!other) {
      await say(ctx, how, ctx.t('bot.report.unavailable'));
      return;
    }
    await say(
      ctx,
      how,
      ctx.t('bot.report.reason', { alias: alias(ctx, other.alias) }),
      reasonKeyboard(ctx, matchId),
    );
  }

  async function askBlock(
    ctx: ChatContext,
    user: ChatUser,
    matchId: string,
    how: 'reply' | 'edit',
  ) {
    const other = await deps.safety.counterpart(user.id, matchId);
    if (!other) {
      await say(ctx, how, ctx.t('bot.block.unavailable'));
      return;
    }
    await say(ctx, how, ctx.t('bot.block.confirm', { alias: alias(ctx, other.alias) }), [
      [{ text: ctx.t('bot.block.yes'), callback_data: encodeCallback('block_yes', matchId) }],
      cancelRow(ctx, matchId),
    ]);
  }

  /** The user's row and their open chats; a stranger to the bot has neither. */
  async function chatsOf(ctx: ChatContext): Promise<{ user: ChatUser | null; chats: ChatRef[] }> {
    const user = await deps.chat.user(ctx.from.id);
    if (!user) return { user: null, chats: [] };
    return { user, chats: (await deps.chats.overview(user)).chats };
  }

  dm.command('report', async (ctx) => {
    const { user, chats } = await chatsOf(ctx);
    const [only, ...others] = chats;
    if (!user || !only) {
      await ctx.reply(ctx.t('bot.report.none'));
      return;
    }
    if (others.length > 0) {
      await ctx.reply(ctx.t('bot.report.pick'), {
        reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'report') },
      });
      return;
    }
    await askReason(ctx, user, only.matchId, 'reply');
  });

  dm.command('block', async (ctx) => {
    const { user, chats } = await chatsOf(ctx);
    const [only, ...others] = chats;
    if (!user || !only) {
      await ctx.reply(ctx.t('bot.block.none'));
      return;
    }
    if (others.length > 0) {
      await ctx.reply(ctx.t('bot.block.pick'), {
        reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'block') },
      });
      return;
    }
    await askBlock(ctx, user, only.matchId, 'reply');
  });

  dm.command('support', async (ctx) => {
    const user = await deps.chat.user(ctx.from.id);
    if (!user || user.status === 'deleted') {
      await ctx.reply(ctx.t('bot.support.no_account'));
      return;
    }
    const text = ctx.match.trim();
    if (text === '' || [...text].length > SUPPORT_MAX_LENGTH) {
      await ctx.reply(ctx.t('bot.support.usage'));
      return;
    }
    const outcome = await deps.support.request(user, text);
    await ctx.reply(
      ctx.t(
        outcome === 'sent'
          ? 'bot.support.sent'
          : outcome === 'too_many'
            ? 'bot.support.too_many'
            : 'bot.support.unavailable',
      ),
    );
  });

  dm.command('delete', async (ctx) => {
    const user = await deps.chat.user(ctx.from.id);
    if (!user) {
      await ctx.reply(ctx.t('bot.delete.none'));
      return;
    }
    if (user.status === 'deleted') {
      await ctx.reply(ctx.t('bot.delete.already'));
      return;
    }
    await ctx.reply(ctx.t('bot.delete.confirm'), {
      reply_markup: {
        inline_keyboard: [
          [{ text: ctx.t('bot.delete.yes'), callback_data: encodeAccountCallback('delete_yes') }],
          [{ text: ctx.t('bot.cancel'), callback_data: encodeAccountCallback('delete_no') }],
        ],
      },
    });
  });

  // The report and block buttons, under a relayed message or in a picker.
  dm.callbackQuery(SAFETY_ACTIONS, async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const user = parsed ? await deps.chat.user(ctx.from.id) : null;
    if (parsed && user) {
      const { action, matchId } = parsed;
      if (action === 'report') {
        await askReason(ctx, user, matchId, 'edit');
      } else if (action === 'block') {
        await askBlock(ctx, user, matchId, 'edit');
      } else if (action === 'block_yes') {
        const outcome = await deps.safety.block({ blockerId: user.id, matchId });
        await edit(
          ctx,
          outcome.status === 'unavailable'
            ? ctx.t('bot.block.unavailable')
            : ctx.t(outcome.status === 'blocked' ? 'bot.block.done' : 'bot.block.already', {
                alias: alias(ctx, outcome.alias),
              }),
        );
      } else if (isReportAction(action)) {
        const outcome = await deps.safety.report({
          reporterId: user.id,
          matchId,
          reason: REPORT_ACTIONS[action],
        });
        await edit(
          ctx,
          outcome.status === 'unavailable'
            ? ctx.t('bot.report.unavailable')
            : ctx.t(outcome.status === 'stored' ? 'bot.report.done' : 'bot.report.duplicate', {
                alias: alias(ctx, outcome.alias),
              }),
        );
      }
    }
    await ctx.answerCallbackQuery();
  });

  // The account buttons: confirming or dropping a deletion.
  dm.callbackQuery(/^u:/, async (ctx) => {
    const parsed = parseAccountCallback(ctx.callbackQuery.data);
    if (parsed?.action === 'delete_no') {
      await edit(ctx, ctx.t('bot.cancelled'));
    } else if (parsed?.action === 'delete_yes') {
      const user = await deps.chat.user(ctx.from.id);
      if (!user) {
        await edit(ctx, ctx.t('bot.delete.none'));
      } else {
        const outcome = await deps.account.deleteAccount(user.id);
        await edit(ctx, ctx.t(outcome === 'deleted' ? 'bot.delete.done' : 'bot.delete.already'));
      }
    }
    await ctx.answerCallbackQuery();
  });
}
