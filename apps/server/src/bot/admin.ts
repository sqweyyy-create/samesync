/**
 * The admin commands (PLAN.md Phase 5). Only for the Telegram IDs in ADMIN_TELEGRAM_IDS, only in
 * a private chat, checked again on every command and every button press; anyone else gets the
 * same answer as for a command that doesn't exist, so nobody can tell these commands are there.
 * The commands are not in the bot's menu either.
 *
 * A command that can't be undone (freeze, a birth-date correction) asks for a tap first. The
 * question is a reply to the admin's own command message, and the button carries only a hash of
 * that text: on the tap the command is read again from the message, checked to be the same
 * admin's, and run. Nothing is kept in memory between the two.
 */
import {
  ageOn,
  bandFor,
  birthDateProblem,
  utcDate,
  type Band,
  type Locale,
} from '@samesync/shared';
import type { Translator } from '@samesync/shared/i18n';
import type { ChatTypeContext, Composer, Context } from 'grammy';
import type { MaybeInaccessibleMessage } from 'grammy/types';
import type { Clock } from '../clock';
import type { AdminUserView, PoolStats, ReportDetails, ReportLine } from '../db/repositories/admin';
import { commandHash, encodeAdminCallback, parseAdminCallback } from '../domain/safety/callbacks';
import type { AdminService } from '../services/admin';

export interface AdminBotDeps {
  adminTelegramIds: readonly number[];
  admin: AdminService;
  clock: Clock;
}

type T = Translator['t'];
type ChatContext = ChatTypeContext<Context & { t: T; locale: Locale }, 'private'>;

/** The commands, none of them in the menu. */
export const ADMIN_COMMANDS = [
  'admin',
  'reports',
  'report_view',
  'resolve',
  'user',
  'freeze',
  'unfreeze',
  'setbirthdate',
  'stats',
  'reply',
] as const;
type AdminCommand = (typeof ADMIN_COMMANDS)[number];

/** Telegram's limit for one message; a report's evidence is cut to fit. */
const MESSAGE_MAX = 4000;
const EVIDENCE_LINE_MAX = 200;

const isAdminCommand = (name: string): name is AdminCommand =>
  (ADMIN_COMMANDS as readonly string[]).includes(name);

/** "/freeze@bot ABC reason" → the command name and the rest. */
function parseCommandText(text: string): { command: AdminCommand; args: string } | null {
  const match = /^\/([a-z_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  if (!name || !isAdminCommand(name)) return null;
  return { command: name, args: (match[2] ?? '').trim() };
}

const cut = (text: string, max: number) =>
  [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
const day = (at: Date) => at.toISOString().slice(0, 10);
const minute = (at: Date) => at.toISOString().slice(0, 16).replace('T', ' ');

export function registerAdmin(dm: Composer<ChatContext>, deps: AdminBotDeps): void {
  const isAdmin = (ctx: ChatContext) => deps.adminTelegramIds.includes(ctx.from.id);

  const band = (t: T, value: Band | null) => t(value ? `admin.band.${value}` : 'admin.band.none');
  const mode = (t: T, value: AdminUserView['mode']) =>
    t(value ? `admin.mode.${value}` : 'admin.none');

  function userText(t: T, user: AdminUserView): string {
    return t('admin.user.view', {
      code: user.publicId,
      telegramId: user.telegramId,
      status: user.status,
      frozen: user.frozenAt ? t('admin.user.frozen_since', { since: minute(user.frozenAt) }) : '',
      band: band(t, user.liveBand),
      locale: user.locale,
      mode: mode(t, user.mode),
      reportsOpen: user.reportsAgainst.open,
      reportsTotal: user.reportsAgainst.total,
      reportsBy: user.reportsBy,
      openMatches: user.openMatches,
      blocks: user.blocksMade,
      createdAt: day(user.createdAt),
      lastActiveAt: minute(user.lastActiveAt),
    });
  }

  const reportLine = (t: T, r: ReportLine) =>
    t('admin.reports.line', {
      seq: r.seq,
      reason: t(`report.reason.${r.reason}`),
      status: t(`admin.report_status.${r.status}`),
      reported: r.reportedCode,
      reporter: r.reporterCode ?? t('admin.reports.system'),
      when: minute(r.createdAt),
    });

  function reportText(t: T, r: ReportDetails): string {
    const header = t('admin.report.view', {
      seq: r.seq,
      reason: t(`report.reason.${r.reason}`),
      status: t(`admin.report_status.${r.status}`),
      reported: r.reportedCode,
      band: band(t, r.reportedBand),
      reporter: r.reporterCode ?? t('admin.reports.system'),
      match: r.matchId,
      when: minute(r.createdAt),
      note: r.note ?? t('admin.report.no_note'),
    });
    let lines: string[];
    if (r.evidence === null) lines = [t('admin.report.evidence_purged')];
    else if (r.evidence.length === 0) lines = [t('admin.report.evidence_empty')];
    else {
      lines = r.evidence.map((line) => {
        const who = t(`admin.report.party.${line.from}`);
        const text =
          line.text === null ? t('admin.report.text_purged') : cut(line.text, EVIDENCE_LINE_MAX);
        return line.verdict === 'delivered'
          ? t('admin.report.line', { who, text })
          : t('admin.report.line_blocked', { who, reason: line.reason ?? line.verdict, text });
      });
    }
    return cut(`${header}\n${lines.join('\n')}`, MESSAGE_MAX);
  }

  const statsText = (t: T, pools: PoolStats[]) =>
    [
      t('admin.stats.header'),
      ...pools.map((p) =>
        t('admin.stats.line', {
          pool: `${p.band}:${p.locale}`,
          mode: p.mode,
          active: p.active,
          open: p.openMatches,
          run: p.lastRun
            ? t('admin.stats.run', {
                when: minute(p.lastRun.finishedAt),
                created: p.lastRun.pairsCreated,
                eligible: p.lastRun.eligibleUsers,
                tiers: Object.entries(p.lastRun.tierCounts)
                  .map(([tier, n]) => `${tier}:${n}`)
                  .join(' '),
              })
            : t('admin.stats.no_run'),
        }),
      ),
    ].join('\n');

  /** Asks the admin to confirm their command: a reply to it, with its hash in the button. */
  async function confirm(ctx: ChatContext, text: string, commandText: string): Promise<void> {
    const messageId = ctx.message?.message_id;
    await ctx.reply(text, {
      ...(messageId === undefined ? {} : { reply_parameters: { message_id: messageId } }),
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: ctx.t('admin.confirm.yes'),
              callback_data: encodeAdminCallback('confirm', commandText),
            },
            {
              text: ctx.t('bot.cancel'),
              callback_data: encodeAdminCallback('cancel', commandText),
            },
          ],
        ],
      },
    });
  }

  /** The user a command names, or the answer that there is none. */
  async function lookup(ctx: ChatContext, ref: string): Promise<AdminUserView | null> {
    const user = await deps.admin.lookup(ref);
    if (!user) await ctx.reply(ctx.t('admin.user.not_found', { ref: cut(ref, 40) }));
    return user;
  }

  /** Runs one command. `confirmed` is true when the admin tapped the button of its question. */
  async function run(
    ctx: ChatContext,
    adminId: number,
    command: AdminCommand,
    args: string,
    commandText: string,
    confirmed: boolean,
  ): Promise<void> {
    const { t } = ctx;
    const [first = '', second = '', ...rest] = args.split(/\s+/).filter(Boolean);
    const after = (n: number) => args.split(/\s+/).filter(Boolean).slice(n).join(' ');
    switch (command) {
      case 'admin':
        await ctx.reply(t('admin.help'));
        return;
      case 'reports': {
        const scope = first === 'all' ? 'all' : 'open';
        const reports = await deps.admin.reports(scope);
        await ctx.reply(
          reports.length === 0
            ? t('admin.reports.none', { scope })
            : [t('admin.reports.header', { scope }), ...reports.map((r) => reportLine(t, r))].join(
                '\n',
              ),
        );
        return;
      }
      case 'report_view': {
        const seq = Number(first);
        if (!/^\d{1,12}$/.test(first)) {
          await ctx.reply(t('admin.report.usage'));
          return;
        }
        const report = await deps.admin.viewReport(seq, adminId);
        await ctx.reply(report ? reportText(t, report) : t('admin.report.not_found', { seq }));
        return;
      }
      case 'resolve': {
        const seq = Number(first);
        if (!/^\d{1,12}$/.test(first) || (second !== 'dismiss' && second !== 'action')) {
          await ctx.reply(t('admin.resolve.usage'));
          return;
        }
        const note = rest.join(' ').trim() || null;
        const outcome = await deps.admin.resolve(seq, second, note, adminId);
        if (outcome.status === 'not_found') await ctx.reply(t('admin.report.not_found', { seq }));
        else if (outcome.status === 'already')
          await ctx.reply(
            t('admin.resolve.already', {
              seq,
              status: t(`admin.report_status.${outcome.current}`),
            }),
          );
        else
          await ctx.reply(
            t('admin.resolve.done', { seq, status: t(`admin.report_status.${outcome.result}`) }),
          );
        return;
      }
      case 'user': {
        if (!first) {
          await ctx.reply(t('admin.user.usage'));
          return;
        }
        const user = await lookup(ctx, first);
        if (user) await ctx.reply(userText(t, user));
        return;
      }
      case 'freeze': {
        const reason = after(1);
        if (!first || !reason) {
          await ctx.reply(t('admin.freeze.usage'));
          return;
        }
        if (!confirmed) {
          const user = await lookup(ctx, first);
          if (!user) return;
          if (user.status !== 'active') {
            await ctx.reply(
              t('admin.freeze.not_active', { code: user.publicId, status: user.status }),
            );
            return;
          }
          await confirm(
            ctx,
            t('admin.freeze.confirm', { code: user.publicId, reason }),
            commandText,
          );
          return;
        }
        const outcome = await deps.admin.freeze(first, reason, adminId);
        if (outcome.status === 'not_found')
          await ctx.reply(t('admin.user.not_found', { ref: cut(first, 40) }));
        else if (outcome.status === 'not_active')
          await ctx.reply(
            t('admin.freeze.not_active', {
              code: outcome.user.publicId,
              status: outcome.user.status,
            }),
          );
        else await ctx.reply(t('admin.freeze.done', { code: outcome.user.publicId }));
        return;
      }
      case 'unfreeze': {
        if (!first) {
          await ctx.reply(t('admin.unfreeze.usage'));
          return;
        }
        const outcome = await deps.admin.unfreeze(first, after(1) || null, adminId);
        if (outcome.status === 'not_found')
          await ctx.reply(t('admin.user.not_found', { ref: cut(first, 40) }));
        else if (outcome.status === 'not_frozen')
          await ctx.reply(
            t('admin.unfreeze.not_frozen', {
              code: outcome.user.publicId,
              status: outcome.user.status,
            }),
          );
        else await ctx.reply(t('admin.unfreeze.done', { code: outcome.user.publicId }));
        return;
      }
      case 'setbirthdate': {
        const reason = after(2);
        if (!first || !second || !reason) {
          await ctx.reply(t('admin.setbirthdate.usage'));
          return;
        }
        const today = utcDate(deps.clock.now());
        if (birthDateProblem(second, today)) {
          await ctx.reply(t('admin.setbirthdate.invalid'));
          return;
        }
        if (!confirmed) {
          const user = await lookup(ctx, first);
          if (!user) return;
          if (user.birthDate === second) {
            await ctx.reply(t('admin.setbirthdate.same', { code: user.publicId }));
            return;
          }
          await confirm(
            ctx,
            t('admin.setbirthdate.confirm', {
              code: user.publicId,
              from: user.birthDate ?? t('admin.none'),
              to: second,
              fromBand: band(t, user.liveBand),
              toBand: band(t, bandFor(ageOn(second, today))),
              reason,
            }),
            commandText,
          );
          return;
        }
        const outcome = await deps.admin.setBirthDate(first, second, reason, adminId);
        if (outcome.status === 'not_found')
          await ctx.reply(t('admin.user.not_found', { ref: cut(first, 40) }));
        else if (outcome.status === 'invalid') await ctx.reply(t('admin.setbirthdate.invalid'));
        else if (outcome.status === 'same')
          await ctx.reply(t('admin.setbirthdate.same', { code: outcome.user.publicId }));
        else
          await ctx.reply(
            t('admin.setbirthdate.done', {
              code: outcome.user.publicId,
              from: outcome.before.birthDate ?? t('admin.none'),
              to: outcome.user.birthDate ?? t('admin.none'),
              band: band(t, outcome.user.liveBand),
            }),
          );
        return;
      }
      case 'stats':
        await ctx.reply(statsText(t, await deps.admin.stats()));
        return;
      case 'reply': {
        const text = after(1);
        if (!first || !text) {
          await ctx.reply(t('admin.reply.usage'));
          return;
        }
        const outcome = await deps.admin.reply(first, text, adminId);
        if (outcome.status === 'not_found')
          await ctx.reply(t('admin.user.not_found', { ref: cut(first, 40) }));
        else await ctx.reply(t('admin.reply.done', { code: outcome.user.publicId }));
        return;
      }
    }
  }

  dm.command([...ADMIN_COMMANDS], async (ctx) => {
    // Not an admin: the same answer as for a command that doesn't exist.
    if (!isAdmin(ctx)) {
      await ctx.reply(ctx.t('bot.unknown_command'));
      return;
    }
    const text = ctx.message?.text ?? '';
    const parsed = parseCommandText(text);
    if (!parsed) return;
    await run(ctx, ctx.from.id, parsed.command, parsed.args, text, false);
  });

  dm.callbackQuery(/^a:/, async (ctx) => {
    const parsed = parseAdminCallback(ctx.callbackQuery.data);
    if (!parsed || !isAdmin(ctx)) {
      // Not an admin, or not one of our buttons: nothing to say.
      await ctx.answerCallbackQuery();
      return;
    }
    const question: MaybeInaccessibleMessage | undefined = ctx.callbackQuery.message;
    const original =
      question && 'reply_to_message' in question ? question.reply_to_message : undefined;
    const text = original?.text;
    if (parsed.action === 'cancel') {
      await ctx.editMessageText(ctx.t('bot.cancelled')).catch(() => undefined);
    } else if (
      !text ||
      original.from?.id !== ctx.from.id ||
      commandHash(text) !== parsed.hash ||
      !parseCommandText(text)
    ) {
      // Edited, gone, or somebody else's command: never acted on.
      await ctx.editMessageText(ctx.t('admin.confirm.stale')).catch(() => undefined);
    } else {
      const { command, args } = parseCommandText(text)!;
      await ctx.editMessageText(text).catch(() => undefined);
      await run(ctx, ctx.from.id, command, args, text, true);
    }
    await ctx.answerCallbackQuery();
  });
}
