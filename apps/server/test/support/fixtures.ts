import { Writable } from 'node:stream';
import type { UserFromGetMe } from 'grammy/types';
import { fixedClock } from '../../src/clock';
import { signInitData } from '../../src/http/auth/init-data-signer';
import { createLogger, type Logger } from '../../src/logger';

/** Fake but well-formed tokens. Tests never use a real bot token. */
export const TEST_BOT_TOKEN = '1234567890:TEST_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const OTHER_BOT_TOKEN = '9876543210:OTHER_TOKEN_bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
export const TEST_MINIAPP_URL = 'https://miniapp.samesync.test/';

export const NOW = new Date('2026-10-02T12:00:00.000Z');
export const MAX_AGE_SEC = 86_400;
export const CLOCK_SKEW_SEC = 60;

export const testClock = () => fixedClock(NOW);

export interface TestUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export const ANYA: TestUser = {
  id: 424242,
  first_name: 'Аня',
  username: 'anya_secret',
  language_code: 'ru',
};
export const BOB: TestUser = {
  id: 515151,
  first_name: 'Bob',
  username: 'bob_secret',
  language_code: 'en',
};

export function initDataFor(
  user: TestUser,
  options: { authDate?: Date; botToken?: string; extra?: Record<string, string> } = {},
): string {
  return signInitData({
    botToken: options.botToken ?? TEST_BOT_TOKEN,
    authDate: options.authDate ?? NOW,
    user: { ...user },
    extra: options.extra ?? { query_id: 'AAH-test', chat_type: 'private' },
  });
}

/** A logger that keeps every line in memory, for asserting what was (not) logged. */
export function memoryLogger(): { logger: Logger; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    logger: createLogger('debug', stream),
    lines: () => chunks.join('').split('\n').filter(Boolean),
  };
}

export const TEST_BOT_INFO: UserFromGetMe = {
  id: 1234567890,
  is_bot: true,
  first_name: 'SameSync',
  username: 'samesync_test_bot',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: true,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};
