/**
 * The chat in the bot's private chat (PLAN.md Phase 4): messages are handed to the relay, and the
 * commands /chats, /leave and /reveal with their buttons are answered here. The handlers stay
 * thin: who may do what is decided by the services, from the database.
 *
 * Safety:
 * - A user's message is never forwarded or copied. The handler passes the relay its text (or the
 *   fact that it isn't text) and nothing else of the update: no name, no username, no ID of the
 *   sender goes beyond the lookup of their own row.
 * - Everything the bot says here names the other person by alias only.
 * - /reveal answers "not available" to anyone who is not an adult by birth date, before any
 *   lookup (CLAUDE.md invariant 6). The reveal service and the database refuse again. A consent
 *   can be taken back ("Передумать") until the reveal has happened (Q38).
 * - Button data is validated; it only names an action and a match.
 */
import { LOCALES, type Locale } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Api, ChatTypeContext, Composer, Context } from 'grammy';
import type { InlineKeyboardButton, MaybeInaccessibleMessage, Message } from 'grammy/types';
import { aliasText, type ContentStore } from '../content/store';
import type { ChatRepository, ChatUser } from '../db/repositories/chat';
import { encodeCallback, parseCallback, type ChatAction } from '../domain/chat/callbacks';
import type { IncomingContent } from '../domain/chat/relay';
import type { ChatService } from '../services/chat';
import type { ChatRef, RelayRefusedReason, RelayResult, RelayService } from '../services/relay';
import type { ConsentOutcome, RevealService, WithdrawOutcome } from '../services/reveal';

export interface ChatBotDeps {
  chat: Pick<ChatRepository, 'user' | 'wasRelayed'>;
  relay: Pick<RelayService, 'send'>;
  chats: ChatService;
  reveal: RevealService;
  content: ContentStore;
  miniAppUrl: string;
  /** The longest message that is relayed, for the notice about one that is longer. */
  maxLength: number;
}

type T = Translator['t'];
type ChatContext = ChatTypeContext<Context & { t: T; locale: Locale }, 'private'>;
type Keyboard = InlineKeyboardButton[][];

/** The commands of the bot's menu, in the order they are listed. */
export const COMMANDS = ['start', 'chats', 'leave', 'reveal', 'help'] as const;

/**
 * Registers the command menu for every locale. Telegram shows it by the language of the client,
 * and English is also what every other language gets (Q13).
 */
export async function registerCommands(api: Pick<Api, 'setMyCommands'>): Promise<void> {
  for (const locale of LOCALES) {
    const { t } = translatorFor(locale);
    const commands = COMMANDS.map((command) => ({
      command,
      description: t(`bot.commands.${command}`),
    }));
    const scope = { type: 'all_private_chats' } as const;
    await api.setMyCommands(commands, { scope, language_code: locale });
    if (locale === 'en') await api.setMyCommands(commands, { scope });
  }
}

/** Messages Telegram writes into the chat itself: nobody sent them, so nobody is answered. */
const SERVICE_KEYS = [
  'pinned_message',
  'write_access_allowed',
  'web_app_data',
  'successful_payment',
  'refunded_payment',
  'users_shared',
  'chat_shared',
  'connected_website',
  'passport_data',
  'message_auto_delete_timer_changed',
  'chat_background_set',
  'boost_added',
  'gift',
  'unique_gift',
  'paid_message_price_changed',
  'direct_message_price_changed',
] as const;

function isServiceMessage(message: Message): boolean {
  const keys = message as unknown as Record<string, unknown>;
  return SERVICE_KEYS.some((key) => keys[key] !== undefined);
}

/** Whether the message a button hangs under is a /chats list, in any of the bot's languages. */
function isChatsList(message: MaybeInaccessibleMessage | undefined): boolean {
  if (!message || !('text' in message) || typeof message.text !== 'string') return false;
  const { text } = message;
  return LOCALES.some((locale) => translatorFor(locale).t('bot.chats.list') === text);
}

/** All the relay may know about a message: its text, or that it has none. */
function contentOf(message: Message): IncomingContent {
  return {
    text: message.text ?? null,
    hasEntities: (message.entities?.length ?? 0) > 0,
  };
}

/** What the sender is told when a message was not relayed. */
function refusalText(t: T, reason: RelayRefusedReason, maxLength: number): string {
  switch (reason) {
    case 'not_text':
    case 'empty':
      return t('bot.chat.text_only');
    case 'too_long':
      return t('bot.chat.too_long', { max: maxLength });
    case 'rate_limited':
      return t('bot.chat.too_fast');
    case 'chat_not_open':
      return t('bot.chat.not_open');
    // Why a chat is over is never said: "ended" is all the other person's state gives away.
    case 'chat_ended':
    case 'band_mismatch':
    case 'blocked':
    case 'recipient_not_active':
    case 'not_found':
      return t('bot.chat.ended');
    case 'sender_not_active':
      return t('bot.chat.unavailable');
    case 'u18_chat_closed':
    case 'screened':
      return t('bot.chat.u18_closed');
    case 'locale_mismatch':
    case 'not_delivered':
      return t('bot.chat.not_delivered');
  }
}

export function registerChat(dm: Composer<ChatContext>, deps: ChatBotDeps): void {
  const alias = (ctx: ChatContext, aliasId: string) => aliasText(deps.content, aliasId, ctx.locale);

  const openApp = (ctx: ChatContext): Keyboard => [
    [{ text: ctx.t('bot.start.open_app'), web_app: { url: deps.miniAppUrl } }],
  ];

  /** One button per chat, each doing `action` to that chat. */
  const chatButtons = (
    ctx: ChatContext,
    chats: readonly ChatRef[],
    action: ChatAction,
    activeMatchId: string | null = null,
  ): Keyboard =>
    chats.map((c) => [
      {
        text: `${c.matchId === activeMatchId ? '✓ ' : ''}${alias(ctx, c.alias)}`,
        callback_data: encodeCallback(action, c.matchId),
      },
    ]);

  const cancelRow = (ctx: ChatContext, matchId: string): InlineKeyboardButton[] => [
    { text: ctx.t('bot.cancel'), callback_data: encodeCallback('cancel', matchId) },
  ];

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

  /** The user's row and their open chats; a stranger to the bot has neither. */
  async function chatsOf(ctx: ChatContext): Promise<{
    user: ChatUser | null;
    chats: ChatRef[];
    activeMatchId: string | null;
  }> {
    const user = await deps.chat.user(ctx.from.id);
    if (!user) return { user: null, chats: [], activeMatchId: null };
    return { user, ...(await deps.chats.overview(user)) };
  }

  const noChats = (ctx: ChatContext) =>
    ctx.reply(ctx.t('bot.chat.none'), { reply_markup: { inline_keyboard: openApp(ctx) } });

  dm.command('chats', async (ctx) => {
    const { chats, activeMatchId } = await chatsOf(ctx);
    if (chats.length === 0) {
      await noChats(ctx);
      return;
    }
    await ctx.reply(ctx.t('bot.chats.list'), {
      reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'to', activeMatchId) },
    });
  });

  const leaveQuestion = (ctx: ChatContext, ref: ChatRef) => ({
    text: ctx.t('bot.leave.confirm', { alias: alias(ctx, ref.alias) }),
    keyboard: [
      [{ text: ctx.t('bot.leave.yes'), callback_data: encodeCallback('leave_yes', ref.matchId) }],
      cancelRow(ctx, ref.matchId),
    ],
  });

  dm.command('leave', async (ctx) => {
    const { chats } = await chatsOf(ctx);
    const [only, ...others] = chats;
    if (!only) {
      await noChats(ctx);
      return;
    }
    // Ending a chat can't be undone: with several chats the user always names the one.
    if (others.length > 0) {
      await ctx.reply(ctx.t('bot.leave.pick'), {
        reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'leave') },
      });
      return;
    }
    const question = leaveQuestion(ctx, only);
    await ctx.reply(question.text, { reply_markup: { inline_keyboard: question.keyboard } });
  });

  /** Only an adult by birth date gets past this (CLAUDE.md invariant 6). */
  const mayReveal = (user: ChatUser | null): user is ChatUser =>
    user !== null && user.status === 'active' && user.liveBand === 'adult';

  /** "Передумать": under every answer that leaves a consent standing before the reveal (Q38). */
  const withdrawRow = (ctx: ChatContext, matchId: string): Keyboard => [
    [
      {
        text: ctx.t('bot.reveal.withdraw'),
        callback_data: encodeCallback('reveal_withdraw', matchId),
      },
    ],
  ];

  function consentReply(
    ctx: ChatContext,
    matchId: string,
    outcome: ConsentOutcome,
  ): { text: string; keyboard?: Keyboard } {
    const standing = withdrawRow(ctx, matchId);
    switch (outcome.status) {
      case 'unavailable':
        return { text: ctx.t('bot.reveal.unavailable') };
      case 'username_needed':
        return { text: ctx.t('bot.reveal.username_needed'), keyboard: standing };
      case 'waiting':
        return {
          text: ctx.t('bot.reveal.waiting', { alias: alias(ctx, outcome.alias) }),
          keyboard: standing,
        };
      case 'other_username_missing':
        return {
          text: ctx.t('bot.reveal.other_username_missing', { alias: alias(ctx, outcome.alias) }),
          keyboard: standing,
        };
      case 'revealed':
        // The usernames themselves come in a message of their own, from the outbox.
        return {
          text: ctx.t(outcome.already ? 'bot.reveal.already' : 'bot.reveal.on_the_way', {
            alias: alias(ctx, outcome.alias),
          }),
        };
    }
  }

  function withdrawText(ctx: ChatContext, outcome: WithdrawOutcome): string {
    switch (outcome.status) {
      case 'unavailable':
        return ctx.t('bot.reveal.unavailable');
      case 'withdrawn':
        return ctx.t('bot.reveal.withdrawn', { alias: alias(ctx, outcome.alias) });
      case 'not_consented':
        return ctx.t('bot.reveal.declined');
      case 'revealed':
        return ctx.t('bot.reveal.already', { alias: alias(ctx, outcome.alias) });
    }
  }

  /** The reveal of one chat as it stands: an offer to agree, or what happened to the consent. */
  async function showReveal(
    ctx: ChatContext,
    user: ChatUser,
    matchId: string,
    how: 'reply' | 'edit',
  ): Promise<void> {
    const state = await deps.reveal.state(user.id, matchId);
    switch (state.status) {
      case 'unavailable':
        await say(ctx, how, ctx.t('bot.reveal.unavailable'));
        return;
      case 'revealed':
        await say(ctx, how, ctx.t('bot.reveal.already', { alias: alias(ctx, state.alias) }));
        return;
      case 'pending': {
        // Consent is given already: see whether the reveal can go through now (a username that
        // was missing may have been set since).
        const reply = consentReply(ctx, matchId, await deps.reveal.consent(user.id, matchId));
        await say(ctx, how, reply.text, reply.keyboard);
        return;
      }
      case 'offer':
        await say(
          ctx,
          how,
          ctx.t(state.theyConsented ? 'bot.reveal.request' : 'bot.reveal.ask', {
            alias: alias(ctx, state.alias),
          }),
          [
            [
              {
                text: ctx.t('bot.reveal.agree'),
                callback_data: encodeCallback('reveal_yes', matchId),
              },
              {
                text: ctx.t('bot.reveal.not_now'),
                callback_data: encodeCallback('reveal_no', matchId),
              },
            ],
          ],
        );
        return;
    }
  }

  dm.command('reveal', async (ctx) => {
    const user = await deps.chat.user(ctx.from.id);
    // Under 18, an unknown age, a stranger: not available, and nothing is looked up.
    if (!mayReveal(user)) {
      await ctx.reply(ctx.t('bot.reveal.unavailable'));
      return;
    }
    const { chats } = await deps.chats.overview(user);
    const [only, ...others] = chats;
    if (!only) {
      await ctx.reply(ctx.t('bot.reveal.none'));
      return;
    }
    // Showing a username can't be undone either: with several chats the user names the one.
    if (others.length > 0) {
      await ctx.reply(ctx.t('bot.reveal.pick'), {
        reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'reveal') },
      });
      return;
    }
    await showReveal(ctx, user, only.matchId, 'reply');
  });

  /** Tells the sender what became of a message. A message that simply went through says nothing. */
  async function answer(ctx: ChatContext, result: RelayResult, messageId: number): Promise<void> {
    const toMessage = { reply_parameters: { message_id: messageId } };
    switch (result.status) {
      case 'delivered':
        if (result.echo) {
          await ctx.reply(ctx.t('bot.chat.sent_to', { alias: alias(ctx, result.alias) }), {
            ...toMessage,
            disable_notification: true,
          });
        }
        return;
      case 'duplicate':
        return;
      case 'pick':
        // A reply to their message: the button that is pressed finds the text through it.
        await ctx.reply(ctx.t('bot.chat.pick'), {
          ...toMessage,
          reply_markup: { inline_keyboard: chatButtons(ctx, result.chats, 'send') },
        });
        return;
      case 'none':
        await noChats(ctx);
        return;
      case 'refused':
        if (result.others && result.others.length > 0) {
          await ctx.reply(ctx.t('bot.chat.ended.pick'), {
            ...toMessage,
            reply_markup: { inline_keyboard: chatButtons(ctx, result.others, 'send') },
          });
          return;
        }
        await ctx.reply(refusalText(ctx.t, result.reason, deps.maxLength), toMessage);
        return;
    }
  }

  dm.on('callback_query:data', async (ctx) => {
    const parsed = parseCallback(ctx.callbackQuery.data);
    const user = parsed ? await deps.chat.user(ctx.from.id) : null;
    if (!parsed || !user) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { action, matchId } = parsed;
    switch (action) {
      case 'to': {
        const ref = await deps.chats.writeHere(user, matchId);
        await ctx.answerCallbackQuery({
          text: ref
            ? ctx.t('bot.chat.now', { alias: alias(ctx, ref.alias) })
            : ctx.t('bot.chat.over'),
        });
        // Pressed in a /chats list: the ✓ moves to the chat that is active now, in that list.
        if (isChatsList(ctx.callbackQuery.message)) {
          const { chats, activeMatchId } = await deps.chats.overview({
            ...user,
            activeMatchId: ref ? matchId : user.activeMatchId,
          });
          try {
            await ctx.editMessageReplyMarkup({
              reply_markup: { inline_keyboard: chatButtons(ctx, chats, 'to', activeMatchId) },
            });
          } catch {
            // An old list, or nothing changed: the answer above said what happened.
          }
        }
        return;
      }
      case 'send': {
        // The message to send is the one this question was asked about.
        const question = ctx.callbackQuery.message;
        const original =
          question && 'reply_to_message' in question ? question.reply_to_message : undefined;
        if (!original || original.from?.id !== ctx.from.id) {
          await edit(ctx, ctx.t('bot.chat.pick.lost'));
          break;
        }
        const result = await deps.relay.send({
          senderId: user.id,
          content: contentOf(original),
          tgMessageId: original.message_id,
          matchId,
        });
        if (result.status === 'delivered') {
          await edit(ctx, ctx.t('bot.chat.picked', { alias: alias(ctx, result.alias) }));
        } else if (result.status === 'duplicate') {
          await edit(ctx, ctx.t('bot.chat.duplicate'));
        } else if (result.status === 'refused') {
          await edit(ctx, refusalText(ctx.t, result.reason, deps.maxLength));
        } else {
          await edit(ctx, ctx.t('bot.chat.ended'));
        }
        break;
      }
      case 'leave': {
        const { chats } = await deps.chats.overview(user);
        const ref = chats.find((c) => c.matchId === matchId);
        if (ref) {
          const question = leaveQuestion(ctx, ref);
          await edit(ctx, question.text, question.keyboard);
        } else {
          await edit(ctx, ctx.t('bot.chat.over'));
        }
        break;
      }
      case 'leave_yes': {
        const ref = await deps.chats.leave(user, matchId);
        await edit(
          ctx,
          ref ? ctx.t('bot.leave.done', { alias: alias(ctx, ref.alias) }) : ctx.t('bot.chat.over'),
        );
        break;
      }
      case 'reveal':
        if (mayReveal(user)) await showReveal(ctx, user, matchId, 'edit');
        else await edit(ctx, ctx.t('bot.reveal.unavailable'));
        break;
      case 'reveal_yes': {
        if (!mayReveal(user)) {
          await edit(ctx, ctx.t('bot.reveal.unavailable'));
          break;
        }
        const reply = consentReply(ctx, matchId, await deps.reveal.consent(user.id, matchId));
        await edit(ctx, reply.text, reply.keyboard);
        break;
      }
      case 'reveal_no':
        // Nothing is stored and the other person is told nothing.
        await edit(ctx, ctx.t('bot.reveal.declined'));
        break;
      case 'reveal_withdraw':
        // The consent is removed, if the reveal has not happened; the other person is told nothing.
        await edit(
          ctx,
          mayReveal(user)
            ? withdrawText(ctx, await deps.reveal.withdraw(user.id, matchId))
            : ctx.t('bot.reveal.unavailable'),
        );
        break;
      case 'cancel':
        await edit(ctx, ctx.t('bot.cancelled'));
        break;
    }
    await ctx.answerCallbackQuery();
  });

  // Edits are not passed on (PLAN.md Phase 4). Only an edit of a message that was relayed is
  // worth a notice: the other person still sees the first version.
  dm.on('edited_message', async (ctx) => {
    const user = await deps.chat.user(ctx.from.id);
    const messageId = ctx.editedMessage.message_id;
    if (user && (await deps.chat.wasRelayed(user.id, messageId))) {
      await ctx.reply(ctx.t('bot.chat.edit'), { reply_parameters: { message_id: messageId } });
    }
  });

  // Everything else a user sends: text goes to the relay, and so does the fact that something is
  // not text, so that one place decides what is never delivered.
  dm.on('message', async (ctx) => {
    const message = ctx.message;
    if (isServiceMessage(message)) return;
    // A command the bot doesn't have is answered, never relayed: a typo of /leave is not a message.
    if (message.text?.startsWith('/')) {
      await ctx.reply(ctx.t('bot.unknown_command'));
      return;
    }
    const user = await deps.chat.user(ctx.from.id);
    if (!user) {
      await noChats(ctx);
      return;
    }
    const result = await deps.relay.send({
      senderId: user.id,
      content: contentOf(message),
      tgMessageId: message.message_id,
      replyToTgMessageId: message.reply_to_message?.message_id ?? null,
    });
    await answer(ctx, result, message.message_id);
  });
}
