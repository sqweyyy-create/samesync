import { z } from 'zod';

const booleanFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  BOT_TOKEN: z
    .string()
    .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'must look like a Telegram bot token from @BotFather'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection URL'),
  MINIAPP_URL: z.url({
    protocol: /^https$/,
    error: 'must be an https:// URL (Telegram requires HTTPS)',
  }),
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  INITDATA_MAX_AGE_SEC: z.coerce
    .number()
    .int()
    .positive()
    .max(7 * 86_400)
    .default(86_400),
  INITDATA_CLOCK_SKEW_SEC: z.coerce.number().int().min(0).max(600).default(60),
  U18_POOL_ENABLED: booleanFlag.default(false),
  ADMIN_TELEGRAM_IDS: z
    .string()
    .regex(/^\d+(,\d+)*$/, 'must be a comma-separated list of numeric Telegram user IDs')
    .transform((v) => v.split(',').map(Number))
    .default([]),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  botToken: string;
  databaseUrl: string;
  miniAppUrl: string;
  http: { host: string; port: number };
  initData: { maxAgeSec: number; clockSkewSec: number };
  u18PoolEnabled: boolean;
  adminTelegramIds: readonly number[];
}

export interface ConfigIssue {
  variable: string;
  message: string;
}

/** Thrown for invalid env. Lists variable names and reasons, never the values (they may be secrets). */
export class ConfigError extends Error {
  constructor(readonly issues: readonly ConfigIssue[]) {
    super(
      'Invalid environment configuration:\n' +
        issues.map((i) => `  - ${i.variable}: ${i.message}`).join('\n'),
    );
    this.name = 'ConfigError';
  }
}

/** Empty strings (e.g. `BOT_TOKEN=` copied from .env.example) count as unset. */
function withoutEmpty(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') result[key] = value.trim();
  }
  return result;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): Config {
  const parsed = EnvSchema.safeParse(withoutEmpty(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => ({
        variable: issue.path.join('.') || '(env)',
        message: issue.message,
      })),
    );
  }
  const e = parsed.data;

  // Safety invariant 12: the u18 pool can't be switched on in production before release gate G3.
  // Removing this check is a deliberate, reviewed code change once G3 is signed off.
  if (e.NODE_ENV === 'production' && e.U18_POOL_ENABLED) {
    throw new ConfigError([
      {
        variable: 'U18_POOL_ENABLED',
        message: 'must be false in production until release gate G3 is signed off (PLAN.md §7)',
      },
    ]);
  }

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    botToken: e.BOT_TOKEN,
    databaseUrl: e.DATABASE_URL,
    miniAppUrl: e.MINIAPP_URL,
    http: { host: e.HTTP_HOST, port: e.HTTP_PORT },
    initData: { maxAgeSec: e.INITDATA_MAX_AGE_SEC, clockSkewSec: e.INITDATA_CLOCK_SKEW_SEC },
    u18PoolEnabled: e.U18_POOL_ENABLED,
    adminTelegramIds: e.ADMIN_TELEGRAM_IDS,
  };
}
