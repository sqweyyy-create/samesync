import { resolveLocale } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { translatorFor } from '@samesync/shared/i18n/static';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { UsersRepository } from '../db/repositories/users';
import type { Logger } from '../logger';

export type BotContext = Context & { t: Translator['t'] };

export interface BotDeps {
  token: string;
  miniAppUrl: string;
  logger: Logger;
  users: Pick<UsersRepository, 'localeOf' | 'storeUsernameIfAdult' | 'setBotReachable'>;
  /** Skips the getMe call; used by tests. */
  botInfo?: UserFromGetMe;
}

export function createBot(deps: BotDeps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  // Q13: a known user's stored locale wins; Telegram's language_code only preselects it for
  // people who never opened the Mini App. Usernames are stored for live adults only (the
  // repository checks the age in SQL), so nothing is stored for u18 users.
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    const stored = from ? await deps.users.localeOf(from.id) : null;
    ctx.t = translatorFor(stored ?? resolveLocale(from?.language_code)).t;
    if (from && ctx.chat?.type === 'private') {
      await deps.users.storeUsernameIfAdult(from.id, from.username ?? null);
      // Whoever writes to the bot can be written to again (after a 403 marked them unreachable).
      if (ctx.message) await deps.users.setBotReachable(from.id, true);
    }
    await next();
  });

  // The bot only talks in private chats; group messages are ignored entirely.
  const dm = bot.chatType('private');

  dm.command('start', async (ctx) => {
    await ctx.reply(ctx.t('bot.start.greeting', { name: ctx.from.first_name }), {
      reply_markup: new InlineKeyboard().webApp(ctx.t('bot.start.open_app'), deps.miniAppUrl),
    });
  });

  dm.command('help', async (ctx) => {
    await ctx.reply(ctx.t('bot.help'));
  });

  // Blocking the bot arrives as "kicked", unblocking as "member". Unreachable users are not
  // matched, so nobody gets a match whose notification can't be delivered.
  dm.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    if (status === 'kicked') await deps.users.setBotReachable(ctx.from.id, false);
    if (status === 'member') await deps.users.setBotReachable(ctx.from.id, true);
  });

  bot.catch((error) => {
    deps.logger.error(
      { err: error.error, updateId: error.ctx.update.update_id },
      'bot handler failed',
    );
  });

  return bot;
}
