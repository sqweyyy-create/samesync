/**
 * `pnpm dev:scenario`: a ready-to-look-at state for the manual check of a phase in Telegram,
 * followed by a numbered checklist of what to do and what must appear. The expected texts are
 * rendered from the real catalogs in the developer's language, so the list never drifts from the
 * product.
 *
 * Rules:
 * - Only the existing dev tools and the real services act: matchMe makes the matches, the game
 *   service plays, the relay and the reveal service act for the synthetic counterpart, the chat
 *   service leaves, the code of the deadlines job expires and reminds, and the outbox sender
 *   delivers. Every write runs as the app role, so every trigger and safety check runs as usual.
 * - A scenario touches the developer's own matches and synthetic users only. It refuses when
 *   another real user is active in the same pool × mode, because a matching run would match them.
 * - Every phase scenario starts with `reset`, so running one twice leaves one set of matches.
 * - Telegram is reached only through `api`: the real bot from the CLI, a fake one in tests.
 *   Nothing is ever sent to a synthetic user (the relay and the outbox skip them).
 */
import type { Band, Locale, Mode } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Api } from 'grammy';
import type pg from 'pg';
import { systemClock } from '../../src/clock';
import { aliasText, type ContentStore } from '../../src/content/store';
import { createDb } from '../../src/db/client';
import { createAdminRepository } from '../../src/db/repositories/admin';
import { createChatRepository } from '../../src/db/repositories/chat';
import { createGamesRepository } from '../../src/db/repositories/games';
import { createMatchesRepository } from '../../src/db/repositories/matches';
import { createMatchingRepository } from '../../src/db/repositories/matching';
import { createOutboxRepository } from '../../src/db/repositories/outbox';
import { createRevealRepository } from '../../src/db/repositories/reveal';
import { createSafetyRepository } from '../../src/db/repositories/safety';
import { createUsersRepository } from '../../src/db/repositories/users';
import { DEFAULT_CHAT_PARAMS } from '../../src/domain/chat/params';
import { renderOpener } from '../../src/domain/game/opener';
import { DEFAULT_GAME_PARAMS } from '../../src/domain/game/params';
import { DEFAULT_MATCHING_PARAMS } from '../../src/domain/matching/params';
import type { Stance } from '../../src/domain/matching/types';
import { DEFAULT_SAFETY_PARAMS } from '../../src/domain/safety/params';
import type { NotificationKind } from '../../src/domain/notifications';
import { LOCK, withAdvisoryLock } from '../../src/jobs/advisory-lock';
import { createGameDeadlines } from '../../src/jobs/game-deadlines';
import { inProcessPlanner } from '../../src/jobs/matching-planner';
import type { Logger } from '../../src/logger';
import { createAdminNotifier } from '../../src/services/admin-alerts';
import { createChatService } from '../../src/services/chat';
import { createContactFilter } from '../../src/services/contact-filter';
import { createGamePlay } from '../../src/services/game';
import { createMatchingService } from '../../src/services/matching';
import { createOutboxSender, type TelegramSender } from '../../src/services/outbox-sender';
import { createRelayService, type RelayTelegram } from '../../src/services/relay';
import { createRevealService, type ConsentOutcome } from '../../src/services/reveal';
import { createSafetyService } from '../../src/services/safety';
import { createUsernames } from '../../src/services/usernames';
import { consentAsCounterpart, devChats, sayAsCounterpart, type DevChat } from './dev-chat';
import { INELIGIBLE_HINT, matchMe } from './match-me';

export const SCENARIO_NAMES = ['phase2', 'phase3', 'phase4', 'phase5', 'reset'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/** A refusal or a failure the developer can act on; the CLI prints its message. */
export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

export interface ScenarioDeps {
  /** App-role connection, with room for a few clients: locks are held while the setup runs. */
  db: pg.Pool;
  content: ContentStore;
  /** The bot the services talk to: the real one from the CLI, a fake one in tests. */
  api: Pick<Api, 'sendMessage' | 'getChat'>;
  miniAppUrl: string;
  fallbackTimeZone: Readonly<Record<Locale, string>>;
  u18PoolEnabled: boolean;
  /** The username a synthetic user "has" (DEV_SYNTHETIC_USERNAME). */
  syntheticUsername: string;
  /** ADMIN_TELEGRAM_IDS: who gets the admin alerts, and whether the developer is one of them. */
  adminTelegramIds: readonly number[];
  /** The bot's own Telegram ID: what the audit names for an automatic freeze. */
  botTelegramId: number;
  logger: Logger;
  /** Waits between tries, and before the delayed step of phase4; tests make it instant. */
  sleep: (ms: number) => Promise<void>;
  /** Synthetic users each matching run's pool should have. */
  poolSize?: number;
  /** Pacing of the outbox sender; the defaults stay under Telegram's limits. */
  pacing?: { spacingMs: number; perChatMs: number };
}

/** The real user a scenario is for. */
export interface Developer {
  id: string;
  publicId: string;
  telegramId: number;
  locale: Locale;
  status: UserStatus;
  /** From the birth date, right now. */
  band: Band | null;
  mode: Mode | null;
}

export interface ScenarioRun {
  summary: string[];
  checklist: string[];
  /** A step that comes a little later on purpose (the counterpart's consent in phase4). */
  later?: { inMs: number; announce: string; run: () => Promise<string> };
}

const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** How phase4 lets the counterpart take its time before it agrees. */
export const COUNTERPART_CONSENT_DELAY_MS = 15_000;

interface UserRow {
  id: string;
  public_id: string;
  telegram_id: string | number;
  locale: Locale;
  status: UserStatus;
  mode: Mode | null;
  band: Band | null;
  synthetic: boolean;
}

const USER_COLUMNS = `id, public_id, telegram_id, locale, status, mode, synthetic,
  vc_band(birth_date, vc_today()) AS band`;

const developer = (row: UserRow): Developer => ({
  id: row.id,
  publicId: row.public_id,
  telegramId: Number(row.telegram_id),
  locale: row.locale,
  status: row.status,
  band: row.band,
  mode: row.mode,
});

/**
 * The developer by support code, or, without one, the only real user of the local database.
 */
export async function findDeveloper(db: pg.Pool, supportCode?: string): Promise<Developer> {
  if (supportCode !== undefined) {
    const code = supportCode.trim().toUpperCase();
    if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(code)) {
      throw new ScenarioError(
        `"${supportCode}" is not a support code (10 characters, see Settings)`,
      );
    }
    const { rows } = await db.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE public_id = $1`,
      [code],
    );
    const row = rows[0];
    if (!row) throw new ScenarioError(`no user with the support code ${code}`);
    if (row.synthetic) throw new ScenarioError(`${code} is a synthetic user`);
    return developer(row);
  }
  const { rows } = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE NOT synthetic ORDER BY created_at, id`,
  );
  const [only, ...others] = rows;
  if (!only) {
    throw new ScenarioError(
      'there is no real user yet: open the Mini App from the bot and finish onboarding',
    );
  }
  if (others.length > 0) {
    throw new ScenarioError(
      `there are several real users, pass a support code: ${rows.map((r) => r.public_id).join(', ')}`,
    );
  }
  return developer(only);
}

/**
 * Closes all open matches of the developer (reason `admin`, their unsent notifications dropped),
 * retires every synthetic user, and clears the developer's active chat, so the next scenario
 * starts clean. A retired synthetic user gets the status `deleted`: the state-change trigger then
 * closes its own open matches and drops its notifications, like for any account that is deleted.
 * The rows stay (the app role deletes nothing), and the developer's profile is never touched.
 */
export async function reset(
  db: pg.Pool,
  user: Pick<Developer, 'id'>,
): Promise<{ closed: number; retired: number }> {
  const closed = await db.query<{ id: string }>(
    `UPDATE matches SET status = 'closed', close_reason = 'admin', closed_at = now()
     WHERE (user_a_id = $1 OR user_b_id = $1) AND status IN ('pending_game', 'results_ready', 'active')
     RETURNING id`,
    [user.id],
  );
  const ids = closed.rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.query(
      `UPDATE outbox SET status = 'cancelled', cancel_reason = 'dev_reset'
       WHERE status = 'pending' AND match_id = ANY($1::uuid[])`,
      [ids],
    );
  }
  let retired = 0;
  for (;;) {
    const batch = await db.query<{ id: string }>(
      `UPDATE users SET status = 'deleted'
       WHERE id IN (
         SELECT id FROM users WHERE synthetic AND status <> 'deleted' ORDER BY id LIMIT 500
       )
       RETURNING id`,
    );
    retired += batch.rows.length;
    if (batch.rows.length < 500) break;
  }
  // Only a routing hint: the chat it pointed to is closed now.
  await createChatRepository(createDb(db)).setActiveMatch(user.id, null);
  return { closed: ids.length, retired };
}

/** The services a scenario acts through, wired like in main.ts. */
function services(deps: ScenarioDeps) {
  const clock = systemClock;
  const { content, logger } = deps;
  const drizzle = createDb(deps.db);
  const users = createUsersRepository(drizzle);
  const matches = createMatchesRepository(drizzle);
  const games = createGamesRepository(drizzle);
  const chat = createChatRepository(drizzle);
  const outbox = createOutboxRepository(drizzle);
  const repo = createMatchingRepository(drizzle);
  // New plain-text messages only: no parse_mode, never forwardMessage or copyMessage.
  const relayTelegram: RelayTelegram = {
    sendMessage: (chatId, text, options) => deps.api.sendMessage(chatId, text, options),
  };
  const senderTelegram: TelegramSender = {
    sendMessage: (chatId, text, options) => deps.api.sendMessage(chatId, text, options),
  };
  const usernames = createUsernames({
    getChat: (chatId) => deps.api.getChat(chatId),
    syntheticUsername: deps.syntheticUsername,
  });
  const safetyRepo = createSafetyRepository(drizzle);
  const adminRepo = createAdminRepository(drizzle);
  const notifier = createAdminNotifier({
    adminTelegramIds: deps.adminTelegramIds,
    users,
    telegram: {
      sendMessage: (chatId, text, options) => deps.api.sendMessage(chatId, text, options),
    },
    logger,
  });
  const safety = createSafetyService({
    safety: safetyRepo,
    admin: adminRepo,
    users,
    matches,
    content,
    notifier,
    clock,
    logger,
    params: DEFAULT_SAFETY_PARAMS,
    systemActorId: () => deps.botTelegramId,
  });
  const relay = createRelayService({
    chat,
    users,
    content,
    telegram: relayTelegram,
    clock,
    logger,
    params: DEFAULT_CHAT_PARAMS,
    contactFilter: createContactFilter({ chat, params: DEFAULT_SAFETY_PARAMS }),
    safety,
  });
  return {
    games,
    chat,
    outbox,
    repo,
    relay,
    safety,
    adminRepo,
    chats: createChatService({
      users,
      matches,
      chat,
      relay,
      telegram: relayTelegram,
      content,
      clock,
      logger,
    }),
    reveal: createRevealService({
      reveal: createRevealRepository(drizzle),
      usernames,
      clock,
      logger,
    }),
    play: createGamePlay({ games, clock }),
    matching: createMatchingService({
      pool: deps.db,
      repo,
      content,
      planner: inProcessPlanner,
      clock,
      logger,
      params: DEFAULT_MATCHING_PARAMS,
      u18PoolEnabled: deps.u18PoolEnabled,
      allowSynthetic: true,
    }),
    sender: createOutboxSender({
      outbox,
      users,
      content,
      telegram: senderTelegram,
      usernames,
      clock,
      logger,
      miniAppUrl: deps.miniAppUrl,
      fallbackTimeZone: deps.fallbackTimeZone,
      sleep: deps.sleep,
      ...(deps.pacing ?? {}),
    }),
    deadlines: createGameDeadlines({ games, clock, logger, params: DEFAULT_GAME_PARAMS }),
  };
}
type Services = ReturnType<typeof services>;

/** Runs `fn` while holding one of the jobs' advisory locks, waiting for it if a job has it. */
async function locked<T>(deps: ScenarioDeps, key: number, what: string, fn: () => Promise<T>) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await withAdvisoryLock(deps.db, key, fn);
    if (result.acquired) return result.value;
    await deps.sleep(250);
  }
  throw new ScenarioError(`${what} stayed busy for 30 s: is another dev:scenario running?`);
}

/** A phase scenario needs an active, onboarded developer who is alone in their pool. */
async function ready(deps: ScenarioDeps, user: Developer): Promise<void> {
  if (user.status !== 'active' || !user.band || !user.mode) {
    throw new ScenarioError(
      `${user.publicId} is "${user.status}", not active: finish onboarding in the Mini App first`,
    );
  }
  const { rows } = await deps.db.query<{ public_id: string }>(
    `SELECT public_id FROM users
     WHERE NOT synthetic AND status = 'active' AND id <> $1
       AND locale = $2 AND mode = $3 AND vc_band(birth_date, vc_today()) = $4
     ORDER BY public_id`,
    [user.id, user.locale, user.mode, user.band],
  );
  if (rows.length > 0) {
    throw new ScenarioError(
      `another real user is active in your pool (${rows.map((r) => r.public_id).join(', ')}): ` +
        'a matching run would match them too, and a scenario touches only your matches and ' +
        'synthetic users',
    );
  }
}

interface Made {
  id: string;
  /** How the counterpart appears to the developer, as a content alias ID. */
  alias: string;
  counterpartId: string;
  /** The teaser, in the developer's language. */
  teaser: string;
}

/** One new match with a synthetic counterpart, through the dev:match-me tooling. */
async function newMatch(
  deps: ScenarioDeps,
  s: Services,
  user: Developer,
  counterpartPlays: boolean,
): Promise<Made> {
  const result = await matchMe(
    {
      db: deps.db,
      content: deps.content,
      matching: s.matching,
      repo: s.repo,
      params: DEFAULT_MATCHING_PARAMS,
      now: systemClock.now(),
      play: s.play,
    },
    {
      publicId: user.publicId,
      poolSize: deps.poolSize ?? 40,
      lookalikes: 3,
      ignoreLimits: true,
      strict: false,
      counterpartPlays,
      seed: Math.floor(Math.random() * 2 ** 31),
    },
  );
  if (result.status === 'user_not_found') {
    throw new ScenarioError(`no user with the support code ${user.publicId}`);
  }
  if (result.status === 'user_not_ready') {
    throw new ScenarioError(`can't match ${user.publicId}: ${result.reason}`);
  }
  if (!result.match) {
    const why = result.ineligible
      ? INELIGIBLE_HINT[result.ineligible]
      : result.run.status === 'disabled'
        ? 'the u18 pool is disabled (U18_POOL_ENABLED=false)'
        : 'no partner was found';
    throw new ScenarioError(`no match for ${user.publicId}: ${why}`);
  }
  if (counterpartPlays && result.match.counterpart !== 'played') {
    throw new ScenarioError('the synthetic counterpart could not play its side of the game');
  }
  const { rows } = await deps.db.query<{
    counterpart_id: string;
    alias: string;
    synthetic: boolean;
  }>(
    `SELECT c.id AS counterpart_id, c.synthetic,
       CASE WHEN m.user_a_id = $2 THEN m.alias_b ELSE m.alias_a END AS alias
     FROM matches m
     JOIN users c ON c.id = CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
     WHERE m.id = $1`,
    [result.match.id, user.id],
  );
  const row = rows[0];
  if (!row?.synthetic) throw new ScenarioError('the new match is not with a synthetic user');
  return {
    id: result.match.id,
    alias: row.alias,
    counterpartId: row.counterpart_id,
    teaser: result.match.teaser,
  };
}

/** Submits `playerId`'s guesses through the game service: three of five right. */
async function playSide(
  deps: ScenarioDeps,
  s: Services,
  matchId: string,
  playerId: string,
): Promise<void> {
  const { rows } = await deps.db.query<{ question_ids: string[]; theirs: Stance[] }>(
    `SELECT g.question_ids,
       (CASE WHEN m.user_a_id = $2 THEN g.answers_b ELSE g.answers_a END)::text[] AS theirs
     FROM matches m JOIN games g ON g.match_id = m.id
     WHERE m.id = $1 AND $2 IN (m.user_a_id, m.user_b_id)`,
    [matchId, playerId],
  );
  const game = rows[0];
  if (!game) throw new ScenarioError('the match has no game');
  const outcome = await s.play.submit(
    playerId,
    matchId,
    game.question_ids.map((questionId, i) => {
      const actual: Stance = game.theirs[i] ?? 'agree';
      const other: Stance = actual === 'agree' ? 'disagree' : 'agree';
      return { questionId, value: i % 5 < 3 ? actual : other };
    }),
  );
  if (outcome.status !== 'submitted') {
    throw new ScenarioError(`the game refused the guesses (${outcome.status})`);
  }
}

/**
 * Moves the game deadline of one match of the developer. The reminder and the expiry then
 * happen through the code of the deadlines job, like for any other match.
 */
async function moveGameDeadline(
  deps: ScenarioDeps,
  matchId: string,
  userId: string,
  to: Date,
): Promise<void> {
  const moved = await deps.db.query(
    `UPDATE matches SET game_deadline_at = $3::timestamptz
     WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2) AND status = 'pending_game'`,
    [matchId, userId, to.toISOString()],
  );
  if (moved.rowCount !== 1) throw new ScenarioError('the game deadline could not be moved');
}

/** Drops notifications of the setup that the scenario does not check. */
async function leaveOut(
  deps: ScenarioDeps,
  s: Services,
  userId: string,
  matchIds: readonly string[],
  kinds: readonly NotificationKind[],
): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM outbox
     WHERE user_id = $1 AND match_id = ANY($2::uuid[]) AND kind::text = ANY($3::text[])
       AND status = 'pending'`,
    [userId, matchIds, kinds],
  );
  for (const row of rows) await s.outbox.cancel(row.id, 'dev_scenario');
  return rows.length;
}

interface Delivery {
  sent: number;
  /** Messages that did not go out: failed, or still waiting for a retry. */
  problems: string[];
}

/** Sends the developer's due notifications about `matchIds` (the caller holds the outbox lock). */
async function deliver(
  deps: ScenarioDeps,
  s: Services,
  userId: string,
  matchIds: readonly string[],
): Promise<Delivery> {
  for (let round = 0; round < 40; round++) {
    const { rows } = await deps.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
       WHERE user_id = $1 AND match_id = ANY($2::uuid[]) AND status = 'pending'
         AND next_attempt_at <= now()`,
      [userId, matchIds],
    );
    if ((rows[0]?.n ?? 0) === 0) break;
    await s.sender.tick();
  }
  const { rows } = await deps.db.query<{ kind: string; status: string; reason: string | null }>(
    `SELECT kind::text AS kind, status::text AS status, coalesce(last_error, cancel_reason) AS reason
     FROM outbox WHERE user_id = $1 AND match_id = ANY($2::uuid[]) ORDER BY created_at, id`,
    [userId, matchIds],
  );
  return {
    sent: rows.filter((r) => r.status === 'sent').length,
    problems: rows
      .filter((r) => r.status === 'failed' || r.status === 'pending')
      .map((r) => `${r.kind}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`),
  };
}

/** What the counterpart writes first: its own opener of the take the game ended on. */
async function openerOf(
  deps: ScenarioDeps,
  s: Services,
  matchId: string,
  counterpartId: string,
): Promise<string> {
  const view = await s.games.getResultsForParticipant(counterpartId, matchId);
  const side = view?.ready ? view.yourAnswers.at(-1) : undefined;
  if (!view?.ready || !side) throw new ScenarioError('the game of this match is not finished');
  return renderOpener(
    { questionId: view.closingQuestionId, side },
    deps.content.game,
    translatorFor(view.locale),
  );
}

async function devChatOf(deps: ScenarioDeps, matchId: string): Promise<DevChat> {
  const chat = (await devChats(deps.db)).find((c) => c.matchId === matchId);
  if (!chat) throw new ScenarioError('the chat with the synthetic counterpart is not open');
  return chat;
}

const resetLine = (cleared: { closed: number; retired: number }) =>
  `Reset: closed ${cleared.closed} of your open matches, retired ${cleared.retired} synthetic users.`;

function deliveryLines(delivery: Delivery): string[] {
  return [
    `Notifications delivered to you: ${delivery.sent}.`,
    ...delivery.problems.map(
      (p) => `Not delivered: ${p}. If the bot is blocked or was never started, send /start to it.`,
    ),
  ];
}

/** phase2: one new match, its notification delivered. */
async function phase2(deps: ScenarioDeps, user: Developer): Promise<ScenarioRun> {
  await ready(deps, user);
  const s = services(deps);
  const cleared = await reset(deps.db, user);
  const { match, delivery } = await locked(deps, LOCK.outbox, 'the outbox', async () => {
    const match = await newMatch(deps, s, user, false);
    return { match, delivery: await deliver(deps, s, user.id, [match.id]) };
  });
  const { t } = translatorFor(user.locale);
  const alias = aliasText(deps.content, match.alias, user.locale);
  return {
    summary: [resetLine(cleared), `New match: ${alias}.`, ...deliveryLines(delivery)],
    checklist: [
      `In the bot: «${t('bot.match.new', { teaser: match.teaser })}» with the button «${t('bot.match.open')}». It arrives once.`,
      `Tap «${t('bot.match.open')}»: the Mini App opens this match on its intro: ${alias}, the teaser and «${t('miniapp.game.play')}».`,
      `Go back: the home screen lists ${alias} under «${t('miniapp.matches.title')}» with «${t('miniapp.match.state.play')}».`,
    ],
  };
}

/**
 * phase3: one match where the counterpart has played, one where the developer will wait for it,
 * one that gets the reminder and one that expires. Only the deadlines of the last two move.
 */
async function phase3(deps: ScenarioDeps, user: Developer): Promise<ScenarioRun> {
  await ready(deps, user);
  const s = services(deps);
  const cleared = await reset(deps.db, user);
  const made = await locked(deps, LOCK.outbox, 'the outbox', async () => {
    const played = await newMatch(deps, s, user, true);
    const waiting = await newMatch(deps, s, user, false);
    const reminded = await newMatch(deps, s, user, false);
    const expiring = await newMatch(deps, s, user, false);
    const now = systemClock.now().getTime();
    const lead = DEFAULT_GAME_PARAMS.reminderHoursBefore * HOUR;
    await moveGameDeadline(deps, reminded.id, user.id, new Date(now + lead - MINUTE));
    await moveGameDeadline(deps, expiring.id, user.id, new Date(now - SECOND));
    await locked(deps, LOCK.gameDeadlines, 'the game deadlines job', () => s.deadlines.run());
    // The server's own job may have got there first: what counts is the state.
    const { rows } = await deps.db.query<{ expired: boolean; reminder: boolean }>(
      `SELECT
         (SELECT status = 'expired' FROM matches WHERE id = $2) AS expired,
         EXISTS (SELECT 1 FROM outbox WHERE user_id = $1 AND match_id = $3 AND kind = 'game_reminder')
           AS reminder`,
      [user.id, expiring.id, reminded.id],
    );
    if (!rows[0]?.expired || !rows[0].reminder) {
      throw new ScenarioError('the deadlines job did not expire and remind as expected');
    }
    const delivery = await deliver(deps, s, user.id, [
      played.id,
      waiting.id,
      reminded.id,
      expiring.id,
    ]);
    return { played, waiting, reminded, expiring, delivery };
  });
  const { t } = translatorFor(user.locale);
  const alias = (m: Made) => aliasText(deps.content, m.alias, user.locale);
  const one = alias(made.played);
  const two = alias(made.waiting);
  const three = alias(made.reminded);
  const four = alias(made.expiring);
  return {
    summary: [
      resetLine(cleared),
      `Matches: ${one} (they have played), ${two} (nobody has), ${three} (reminded), ${four} (expired).`,
      ...deliveryLines(made.delivery),
    ],
    checklist: [
      `«${t('bot.game.turn', { alias: one })}» with «${t('bot.game.play')}». Tap it, guess the cards and send: the results show both scores, every card side by side and last «${t('miniapp.results.closing')}» with a first message to edit.`,
      `${two}: open it from its «${t('bot.match.new', { teaser: made.waiting.teaser })}» or from the home screen, play and send: «${t('miniapp.game.waiting', { alias: two })}» (the waiting screen; this counterpart never plays).`,
      `«${t('bot.game.reminder', { alias: three, count: DEFAULT_GAME_PARAMS.reminderHoursBefore })}» arrives once, with «${t('bot.game.play')}».`,
      `«${t('bot.game.expired', { alias: four })}» arrives once, and ${four} is not on the home screen. (Its new-match message never comes: it expired first.)`,
    ],
  };
}

/**
 * phase4: chats A and B with a message from each counterpart, a reveal request from A waiting for
 * the developer, the developer's consent in B with the counterpart's coming a little later, a
 * chat C that its counterpart ends, and D, a finished game nobody has written in yet.
 */
async function phase4(deps: ScenarioDeps, user: Developer): Promise<ScenarioRun> {
  await ready(deps, user);
  if (user.band !== 'adult') {
    throw new ScenarioError(
      'phase4 needs an adult account: the chat is closed in the u18 band until Phase 5',
    );
  }
  const s = services(deps);
  const cleared = await reset(deps.db, user);
  const setup = await locked(deps, LOCK.outbox, 'the outbox', async () => {
    const made: Made[] = [];
    for (let i = 0; i < 4; i++) {
      const match = await newMatch(deps, s, user, true);
      await playSide(deps, s, match.id, user.id);
      made.push(match);
    }
    const [a, b, c, d] = made as [Made, Made, Made, Made];
    // The game messages of the setup are not what this phase checks. D keeps its "results are
    // ready": it is the way into its first message.
    await leaveOut(
      deps,
      s,
      user.id,
      [a.id, b.id, c.id],
      ['match_created', 'game_turn', 'game_results'],
    );
    await leaveOut(deps, s, user.id, [d.id], ['match_created', 'game_turn']);
    // One message from each counterpart of A, B and C, through the real relay.
    const texts = new Map<string, string>();
    for (const match of [a, b, c]) {
      const text = await openerOf(deps, s, match.id, match.counterpartId);
      const said = await sayAsCounterpart(s, await devChatOf(deps, match.id), text);
      if (said.status !== 'delivered') {
        throw new ScenarioError(
          `the relay did not deliver the counterpart's message (${said.status === 'refused' ? said.reason : said.status})`,
        );
      }
      texts.set(match.id, text);
    }
    // A asks to exchange usernames and waits for the answer.
    const asked = await consentAsCounterpart(s, await devChatOf(deps, a.id));
    if (asked.status !== 'waiting') {
      throw new ScenarioError(
        `the counterpart of A could not ask for the reveal (${asked.status})`,
      );
    }
    // In B the developer has agreed already; the counterpart follows later (`later` below).
    const yours = await s.reveal.consent(user.id, b.id);
    if (yours.status !== 'waiting' && yours.status !== 'username_needed') {
      throw new ScenarioError(`your consent in B was not recorded (${yours.status})`);
    }
    // C's counterpart ends the chat.
    const leaver = await s.chat.userById(c.counterpartId);
    if (!leaver || !(await s.chats.leave(leaver, c.id))) {
      throw new ScenarioError('the counterpart of C could not leave the chat');
    }
    const delivery = await deliver(deps, s, user.id, [a.id, b.id, c.id, d.id]);
    return { a, b, c, d, texts, yours, delivery };
  });

  const { a, b, c, d, texts, yours } = setup;
  const { t } = translatorFor(user.locale);
  const name = (m: Made) => aliasText(deps.content, m.alias, user.locale);
  const [A, B, C, D] = [name(a), name(b), name(c), name(d)];
  const username = deps.syntheticUsername;
  const said = (m: Made) => `«${name(m)} / ${texts.get(m.id) ?? ''}»`;
  const later = Math.round(COUNTERPART_CONSENT_DELAY_MS / SECOND);
  // Whether the developer's Telegram account has a username: without one a consent is recorded
  // and waits (Q25), and the reveal items say so.
  const hasUsername = yours.status === 'waiting';
  const agree = t('bot.reveal.agree');
  const withdraw = t('bot.reveal.withdraw');
  const counterpartFirst = hasUsername
    ? `Reveal, the counterpart first: under «${t('bot.reveal.request', { alias: A })}» tap «${agree}»: «${t('bot.reveal.on_the_way', { alias: A })}», then «${t('bot.reveal.done', { alias: A, username })}».`
    : `Reveal, the counterpart first: under «${t('bot.reveal.request', { alias: A })}» tap «${agree}»: «${t('bot.reveal.username_needed')}» (your Telegram account has no username). Set one in Telegram, send /reveal and pick ${A}: «${t('bot.reveal.on_the_way', { alias: A })}», then «${t('bot.reveal.done', { alias: A, username })}».`;
  const youFirst = hasUsername
    ? `Reveal, you first: your consent in ${B} is recorded already. About ${later} s after this list its counterpart agrees: «${t('bot.reveal.done', { alias: B, username })}».`
    : `Reveal, you first: your Telegram account has no username, so your consent in ${B} waits («${t('bot.reveal.username_needed')}»). Set a username in Telegram, send /reveal and pick ${B}: «${t('bot.reveal.on_the_way', { alias: B })}», then «${t('bot.reveal.done', { alias: B, username })}».`;
  const withdrawal = `Withdrawal (Q38): send /reveal, pick ${D}, tap «${agree}»: «${hasUsername ? t('bot.reveal.waiting', { alias: D }) : t('bot.reveal.username_needed')}» with «${withdraw}». Tap it: «${t('bot.reveal.withdrawn', { alias: D })}». Send /reveal and pick ${D}: «${t('bot.reveal.ask', { alias: D })}» is offered again.`;

  return {
    summary: [
      resetLine(cleared),
      `Chats: ${A} and ${B} (a message from each), ${C} (ended by its counterpart), ${D} (finished game, nobody has written).`,
      'The game messages of the setup were left out, except the results of ' + D + '.',
      ...deliveryLines(setup.delivery),
    ],
    checklist: [
      `Reply routing: swipe-reply to ${said(a)}. The reply goes to ${A}: the bot notes «${t('bot.chat.sent_to', { alias: A })}», and \`pnpm dev:say ${a.alias}\` shows it as \`you [delivered]\`. A reply to ${said(b)} lands in \`pnpm dev:say ${b.alias}\`.`,
      `The chooser: send a plain message (not a reply): «${t('bot.chat.pick')}» with ${A}, ${B} and ${D}. Tap ${B}: «${t('bot.chat.picked', { alias: B })}». The next plain message goes to ${B} without a question.`,
      `/chats: «${t('bot.chats.list')}», ${B} marked ✓. Tap ${A}: «${t('bot.chat.now', { alias: A })}», and the ✓ in the list moves to ${A}. A plain message now goes to ${A}, and the bot notes «${t('bot.chat.sent_to', { alias: A })}».`,
      `Edits and media: edit one of your sent messages: «${t('bot.chat.edit')}». Send a sticker or a photo: «${t('bot.chat.text_only')}».`,
      counterpartFirst,
      youFirst,
      `A chat the counterpart ended: «${t('bot.chat.ended.other', { alias: C })}». Reply to ${said(c)}: «${t('bot.chat.ended')}».`,
      `/leave: «${t('bot.leave.pick')}», pick ${A}: «${t('bot.leave.confirm', { alias: A })}», tap «${t('bot.leave.yes')}»: «${t('bot.leave.done', { alias: A })}».`,
      `The Mini App: under «${t('bot.game.results', { alias: D })}» tap «${t('bot.game.see_results')}». Edit the first message, tap «${t('miniapp.results.send')}»: «${t('miniapp.results.sent')}», and «${t('miniapp.results.to_chat')}» closes the app. In the bot: «${t('bot.chat.you_to', { alias: D })}» and your text.`,
      withdrawal,
    ],
    later: {
      inMs: COUNTERPART_CONSENT_DELAY_MS,
      announce: `In ${later} s the counterpart of ${B} agrees to exchange usernames (item 6). Keep this running.`,
      run: async () => {
        const outcome: ConsentOutcome = await consentAsCounterpart(s, await devChatOf(deps, b.id));
        const delivery = await locked(deps, LOCK.outbox, 'the outbox', () =>
          deliver(deps, s, user.id, [b.id]),
        );
        if (outcome.status === 'revealed' && delivery.problems.length === 0) {
          return `The counterpart of ${B} agreed: «${t('bot.reveal.done', { alias: B, username })}» is in the bot.`;
        }
        if (outcome.status === 'other_username_missing') {
          return `The counterpart of ${B} agreed, but your account has no Telegram username: see item 6.`;
        }
        return `The counterpart of ${B} answered "${outcome.status}"${delivery.problems.length > 0 ? `; not delivered: ${delivery.problems.join(', ')}` : ''}.`;
      },
    },
  };
}

/** The developer reports the other person of one of their matches (tests of the scenario). */
export function reportAsDeveloper(
  deps: ScenarioDeps,
  user: Pick<Developer, 'id'>,
  matchId: string,
) {
  return services(deps).safety.report({ reporterId: user.id, matchId, reason: 'spam' });
}

/** A synthetic user matched with `userId`, in any run, with the match between them. */
interface SyntheticMatch {
  userId: string;
  matchId: string;
}

/** Synthetic users who have a match with `userId`, newest first. */
async function syntheticMatchesOf(deps: ScenarioDeps, userId: string): Promise<SyntheticMatch[]> {
  const { rows } = await deps.db.query<{ user_id: string; match_id: string }>(
    `SELECT c.id AS user_id, m.id AS match_id
     FROM matches m
     JOIN users c ON c.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
     WHERE (m.user_a_id = $1 OR m.user_b_id = $1) AND c.synthetic AND c.status = 'active'
     ORDER BY m.created_at DESC, m.id DESC`,
    [userId],
  );
  return rows.map((r) => ({ userId: r.user_id, matchId: r.match_id }));
}

/**
 * phase5: chats A and B with a message from each counterpart (report and block from the message),
 * a chat C whose counterpart two other people have reported already (your report freezes it),
 * chats D and E for the admin commands (/freeze, /setbirthdate), and F for the Mini App. The
 * line to add to .env to be an admin is printed when you are not one yet.
 */
async function phase5(deps: ScenarioDeps, user: Developer): Promise<ScenarioRun> {
  await ready(deps, user);
  const s = services(deps);
  const cleared = await reset(deps.db, user);
  const setup = await locked(deps, LOCK.outbox, 'the outbox', async () => {
    const made: Made[] = [];
    for (let i = 0; i < 6; i++) {
      const match = await newMatch(deps, s, user, true);
      await playSide(deps, s, match.id, user.id);
      made.push(match);
    }
    const [a, b, c, d, e, f] = made as [Made, Made, Made, Made, Made, Made];
    // The game messages of the setup are not what this phase checks. F keeps its "results are
    // ready": it is the way into the Mini App.
    await leaveOut(
      deps,
      s,
      user.id,
      made.slice(0, 5).map((m) => m.id),
      ['match_created', 'game_turn', 'game_results'],
    );
    await leaveOut(deps, s, user.id, [f.id], ['match_created', 'game_turn']);
    // One message from each counterpart of A, B and C, through the real relay.
    const texts = new Map<string, string>();
    for (const match of [a, b, c]) {
      const text = await openerOf(deps, s, match.id, match.counterpartId);
      const said = await sayAsCounterpart(s, await devChatOf(deps, match.id), text);
      if (said.status !== 'delivered') {
        throw new ScenarioError(
          `the relay did not deliver the counterpart's message (${said.status === 'refused' ? said.reason : said.status})`,
        );
      }
      texts.set(match.id, text);
    }
    // Two other people reported the counterpart of C before: synthetic users matched with it in
    // the runs above, reporting through the real service. Your report will be the third.
    let others = (await syntheticMatchesOf(deps, c.counterpartId)).slice(0, 2);
    for (let extra = 0; others.length < 2 && extra < 4; extra++) {
      const outcome = await s.matching.run({
        pool: { band: user.band!, locale: user.locale },
        mode: user.mode!,
        slot: new Date(systemClock.now().getTime() + extra + 1),
        params: {
          tier2AfterHours: 0,
          tier3AfterHours: 0,
          dailyLimit: 1_000_000,
          openLimit: 1_000_000,
        },
      });
      if (outcome.status !== 'done') break;
      // A run of the whole pool may give you another match too: not one of this scenario.
      await deps.db.query(
        `UPDATE matches SET status = 'closed', close_reason = 'admin', closed_at = now()
         WHERE (user_a_id = $1 OR user_b_id = $1) AND status IN ('pending_game', 'results_ready', 'active')
           AND id <> ALL($2::uuid[])`,
        [user.id, made.map((m) => m.id)],
      );
      others = (await syntheticMatchesOf(deps, c.counterpartId)).slice(0, 2);
    }
    if (others.length < 2) {
      throw new ScenarioError(
        'could not find two synthetic users matched with the counterpart of C',
      );
    }
    for (const other of others) {
      const reported = await s.safety.report({
        reporterId: other.userId,
        matchId: other.matchId,
        reason: 'spam',
      });
      if (reported.status !== 'stored') {
        throw new ScenarioError(
          `a synthetic user could not report the counterpart of C (${reported.status})`,
        );
      }
    }
    const codes = await deps.db.query<{ id: string; public_id: string; birth_date: string }>(
      'SELECT id, public_id, birth_date::text AS birth_date FROM users WHERE id = ANY($1::uuid[])',
      [[a, b, c, d, e, f].map((m) => m.counterpartId)],
    );
    const codeOf = (m: Made) => codes.rows.find((r) => r.id === m.counterpartId)!;
    const delivery = await deliver(
      deps,
      s,
      user.id,
      made.map((m) => m.id),
    );
    return { a, b, c, d, e, f, texts, codeOf, delivery };
  });

  const { a, b, c, d, e, f, texts, codeOf } = setup;
  const { t } = translatorFor(user.locale);
  const name = (m: Made) => aliasText(deps.content, m.alias, user.locale);
  const [A, B, C, D, E, F] = [name(a), name(b), name(c), name(d), name(e), name(f)];
  const said = (m: Made) => `«${name(m)} / ${texts.get(m.id) ?? ''}»`;
  const isAdmin = deps.adminTelegramIds.includes(user.telegramId);
  const you = user.publicId;
  const u18Date = new Date(systemClock.now());
  u18Date.setUTCFullYear(u18Date.getUTCFullYear() - 16);
  const sixteen = u18Date.toISOString().slice(0, 10);
  const reasonSpam = t('report.reason.spam');
  const adminLine = isAdmin
    ? 'You are an admin (your Telegram ID is in ADMIN_TELEGRAM_IDS): the admin items below work.'
    : `You are not an admin yet. Add this line to .env and restart pnpm dev:up, then run this scenario again:\n  ADMIN_TELEGRAM_IDS=${user.telegramId}`;

  return {
    summary: [
      resetLine(cleared),
      `Chats: ${A}, ${B} and ${C} (a message from each; the counterpart of ${C} was reported by two other people already), ${D} and ${E} (for the admin commands), ${F} (a finished game, for the Mini App).`,
      `Support codes of the counterparts: ${A} ${codeOf(a).public_id}, ${B} ${codeOf(b).public_id}, ${C} ${codeOf(c).public_id}, ${D} ${codeOf(d).public_id}, ${E} ${codeOf(e).public_id}, ${F} ${codeOf(f).public_id}. Yours: ${you}.`,
      adminLine,
      'The u18 contact filter is not part of this check: it runs only in the u18 pool and is covered by the automated tests.',
      ...deliveryLines(setup.delivery),
    ],
    checklist: [
      `Report from a message: under ${said(a)} tap «${t('bot.chat.report')}»: «${t('bot.report.reason', { alias: A })}» with the six reasons. Tap «${reasonSpam}»: «${t('bot.report.done', { alias: A })}». Tap «${t('bot.chat.report')}» under the same message and a reason again: «${t('bot.report.duplicate', { alias: A })}».`,
      `Block from a message: under ${said(b)} tap «${t('bot.chat.block')}»: «${t('bot.block.confirm', { alias: B })}». Tap «${t('bot.block.yes')}»: «${t('bot.block.done', { alias: B })}». /chats no longer lists ${B}, and a reply to ${said(b)} gets «${t('bot.chat.ended')}».`,
      `Auto-freeze: send /report: «${t('bot.report.pick')}» with your chats. Tap ${C}, then «${reasonSpam}»: «${t('bot.report.done', { alias: C })}». Two other people had reported this person already, so the account is frozen now: ${C} is gone from /chats${isAdmin ? `, and you (as admin) get «Аккаунт ${codeOf(c).public_id} заморожен автоматически: 3 жалобы от разных пользователей за 30 дн. Открыть: /user ${codeOf(c).public_id}»` : ' (the admin alert goes to ADMIN_TELEGRAM_IDS)'}.`,
      `Admin, reports: /reports lists the three reports (yours on ${A} and ${C}, and the two on ${C}'s counterpart); /report_view <number of your report on ${A}> shows it with the last messages of that chat, by «${t('admin.report.party.reporter')}» and «${t('admin.report.party.reported')}»; /resolve <that number> dismiss: «${t('admin.resolve.done', { seq: '<number>', status: t('admin.report_status.dismissed') })}».`,
      `Admin, a user: /user ${codeOf(d).public_id}: the view with «Код: ${codeOf(d).public_id}», «Статус: active», «Возраст: 18+», the report counts and the open matches. No name, no username.`,
      `Admin, freeze: /freeze ${codeOf(d).public_id} test: «${t('admin.freeze.confirm', { code: codeOf(d).public_id, reason: 'test' })}» with «${t('admin.confirm.yes')}» and «${t('bot.cancel')}». Tap «${t('admin.confirm.yes')}»: «${t('admin.freeze.done', { code: codeOf(d).public_id })}», and ${D} is gone from /chats. /unfreeze ${codeOf(d).public_id} checked: «${t('admin.unfreeze.done', { code: codeOf(d).public_id })}», and ${D} stays gone.`,
      `Admin, a birth date: /setbirthdate ${codeOf(e).public_id} ${sixteen} test: the question with «${codeOf(e).birth_date} → ${sixteen} (возраст: 18+ → до 18)». Tap «${t('admin.confirm.yes')}»: «${t('admin.setbirthdate.done', { code: codeOf(e).public_id, from: codeOf(e).birth_date, to: sixteen, band: t('admin.band.u18') })}», and ${E} is gone from /chats at once (closed for the band change).`,
      `Admin, pools: /stats: «${t('admin.stats.header')}» and one line per pool × mode, with your pool's last run.`,
      `Support: send «/support привет»: «${t('bot.support.sent')}»${isAdmin ? `, and you (as admin) get «Поддержка · ${you} (${user.locale}):» with your text` : ''}. ${isAdmin ? `Answer with /reply ${you} ответ: «${t('admin.reply.done', { code: you })}», then «${t('bot.support.reply', { text: 'ответ' })}» arrives.` : 'The request goes to ADMIN_TELEGRAM_IDS.'}`,
      `The Mini App: under «${t('bot.game.results', { alias: F })}» tap «${t('bot.game.see_results')}»: at the bottom «${t('miniapp.safety.report')}» and «${t('miniapp.safety.block')}». Tap «${t('miniapp.safety.report')}», pick «${reasonSpam}», tap «${t('miniapp.report.send')}»: «${t('miniapp.report.sent')}». Tap «${t('miniapp.safety.block')}», then «${t('miniapp.block.yes')}»: «${t('miniapp.block.done')}», and ${F} is gone from the home screen.`,
      `Optional, destructive: /delete asks «${t('bot.delete.confirm')}»; «${t('bot.cancel')}» changes nothing. «${t('bot.delete.yes')}» deletes your account for good (you would onboard again from /start): skip it unless you mean it.`,
    ],
  };
}

export const SCENARIOS: Readonly<
  Record<
    Exclude<ScenarioName, 'reset'>,
    (deps: ScenarioDeps, user: Developer) => Promise<ScenarioRun>
  >
> = { phase2, phase3, phase4, phase5 };
