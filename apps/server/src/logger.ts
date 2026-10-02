import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * Fields that must never reach the logs (CLAUDE.md: no message bodies, birth dates, usernames,
 * initData, tokens or payment payloads). Pino replaces them with "[redacted]".
 */
export const REDACT_PATHS = [
  'authorization',
  'headers.authorization',
  'req.headers.authorization',
  'initData',
  '*.initData',
  'initDataRaw',
  '*.initDataRaw',
  'botToken',
  '*.botToken',
  'token',
  '*.token',
  'birthDate',
  '*.birthDate',
  'birth_date',
  '*.birth_date',
  'username',
  '*.username',
  'text',
  '*.text',
  'body',
  '*.body',
  'payload',
  '*.payload',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'samesync' },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}
