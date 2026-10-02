/* eslint-disable no-console -- CLI output */
/**
 * Prints initData signed with the DEV bot token, plus a URL that opens the Mini App in a normal
 * browser with these launch params. The server validates it like any other initData: there is no
 * auth bypass. Refuses to run in production. Never prints the bot token.
 *
 *   pnpm dev:initdata [--user-id 100000001] [--first-name Dev] [--lang ru|en] [--url http://localhost:5173]
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { signInitData } from '../src/http/auth/init-data-signer';

if (process.env['NODE_ENV'] === 'production') {
  console.error('dev:initdata refuses to run with NODE_ENV=production');
  process.exit(1);
}

const botToken = process.env['BOT_TOKEN'] ?? '';
if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
  console.error(
    'BOT_TOKEN is missing or invalid. Put your DEV bot token into .env (see .env.example).',
  );
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    'user-id': { type: 'string', default: '100000001' },
    'first-name': { type: 'string', default: 'Dev' },
    lang: { type: 'string', default: 'ru' },
    url: { type: 'string', default: process.env['MINIAPP_DEV_URL'] ?? 'http://localhost:5173' },
  },
});

const userId = Number(values['user-id']);
if (!Number.isSafeInteger(userId) || userId <= 0) {
  console.error('--user-id must be a positive integer');
  process.exit(1);
}

const initData = signInitData({
  botToken,
  authDate: new Date(),
  user: {
    id: userId,
    first_name: values['first-name'],
    language_code: values.lang,
    allows_write_to_pm: true,
  },
  // Real initData always has `signature` (Ed25519, for third-party validation) and the SDK requires
  // it. We can't produce Telegram's signature; our server checks the HMAC `hash`, which covers it.
  extra: {
    query_id: `dev-${randomUUID()}`,
    chat_type: 'private',
    signature: randomBytes(64).toString('base64url'),
  },
});

// Same launch-param layout Telegram uses when it opens a Mini App (URL hash).
const launchParams = new URLSearchParams({
  tgWebAppData: initData,
  tgWebAppVersion: '9.0',
  tgWebAppPlatform: 'web',
  tgWebAppThemeParams: JSON.stringify({ bg_color: '#ffffff', text_color: '#000000' }),
});

console.log(`Signed initData for user ${userId} (valid for INITDATA_MAX_AGE_SEC, default 24h):\n`);
console.log(initData);
console.log('\nOpen the Mini App in a browser with these launch params:\n');
console.log(`${values.url}/#${launchParams.toString()}`);
