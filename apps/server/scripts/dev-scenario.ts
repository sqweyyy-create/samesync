/* eslint-disable no-console -- CLI output */
/**
 * `pnpm dev:scenario <name> [support code]`: prepares a ready-to-look-at state for the manual
 * check of a phase in Telegram, then prints a numbered checklist of what to do in the bot or the
 * Mini App and what must appear. The support code defaults to the only real user of the local
 * database. Refuses to run with NODE_ENV=production.
 *
 *   phase2  one new match, its notification delivered
 *   phase3  the game: one to play through to the results, one to wait in, one reminded, one expired
 *   phase4  the chat: two chats with a message each, a reveal asked by a counterpart, your consent
 *           with the counterpart's a few seconds later, a chat its counterpart ended, and a fresh
 *           finished game for the Mini App's "Написать"
 *   phase5  safety and admin: chats to report and block from, a counterpart two others reported
 *           already (your report freezes it), chats for /freeze and /setbirthdate, one for the
 *           Mini App, and the .env line that makes your account an admin (it is printed, never
 *           written)
 *   reset   closes your open matches and retires the synthetic users (your profile stays as it is)
 *
 * Every phase scenario starts with a reset. It acts only through the dev tools and the real
 * services (see scripts/lib/scenarios.ts), so every safety check runs as usual.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Api } from 'grammy';
import { ConfigError, loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { DEV_SYNTHETIC_USERNAME } from '../src/services/usernames';
import { connect, fail, refuseInProduction } from './lib/dev-runtime';
import {
  SCENARIOS,
  SCENARIO_NAMES,
  ScenarioError,
  findDeveloper,
  reset,
  type ScenarioName,
} from './lib/scenarios';

refuseInProduction('dev:scenario');

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const [name, supportCode] = positionals;
const isScenario = (value: string | undefined): value is ScenarioName =>
  (SCENARIO_NAMES as readonly string[]).includes(value ?? '');
if (!isScenario(name)) {
  fail(`Usage: pnpm dev:scenario <${SCENARIO_NAMES.join('|')}> [support code]`);
}

const { db, content } = await connect({ max: 8 });
let exitCode = 1;
try {
  const user = await findDeveloper(db, supportCode);
  console.log(`dev:scenario ${name} for ${user.publicId}`);
  if (name === 'reset') {
    const cleared = await reset(db, user);
    console.log(
      `Closed ${cleared.closed} of your open matches, retired ${cleared.retired} synthetic users. ` +
        'Your profile is unchanged.',
    );
  } else {
    // The same configuration the server uses: messages go out through the bot's own token.
    let config;
    try {
      config = loadConfig(process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      fail(error.message);
    }
    const api = new Api(config.botToken);
    const run = await SCENARIOS[name](
      {
        db,
        content,
        api,
        miniAppUrl: config.miniAppUrl,
        fallbackTimeZone: {
          ru: config.matching.drops.ru.timeZone,
          en: config.matching.drops.en.timeZone,
        },
        u18PoolEnabled: config.u18PoolEnabled,
        syntheticUsername: DEV_SYNTHETIC_USERNAME,
        adminTelegramIds: config.adminTelegramIds,
        botTelegramId: (await api.getMe()).id,
        logger: createLogger('error'),
        sleep: (ms) => sleep(ms),
      },
      user,
    );
    for (const line of run.summary) console.log(line);
    console.log('\nCheck in Telegram (pnpm dev must be running, e.g. through pnpm dev:up):');
    run.checklist.forEach((item, i) => console.log(`${String(i + 1).padStart(2)}. ${item}`));
    if (run.later) {
      console.log(`\n${run.later.announce}`);
      await sleep(run.later.inMs);
      console.log(await run.later.run());
    }
  }
  exitCode = 0;
} catch (error) {
  if (!(error instanceof ScenarioError)) throw error;
  console.error(`dev:scenario ${name}: ${error.message}`);
} finally {
  await db.end();
}
process.exit(exitCode);
