import { resolveLocale } from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import { translatorFor } from '@samesync/shared/i18n/static';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { Logger } from '../logger';

export type BotContext = Context & { t: Translator['t'] };

export interface BotDeps {
  token: string;
  miniAppUrl: string;
  logger: Logger;
  /** Skips the getMe call; used by tests. */
  botInfo?: UserFromGetMe;
}

export function createBot(deps: BotDeps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});

  // Phase 0: locale comes from the Telegram client. Later phases use the stored user locale.
  bot.use(async (ctx, next) => {
    ctx.t = translatorFor(resolveLocale(ctx.from?.language_code)).t;
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

  bot.catch((error) => {
    deps.logger.error(
      { err: error.error, updateId: error.ctx.update.update_id },
      'bot handler failed',
    );
  });

  return bot;
}
