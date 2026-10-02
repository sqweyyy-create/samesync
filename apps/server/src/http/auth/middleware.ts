import { AUTH_SCHEME, type ApiErrorBody } from '@samesync/shared/api';
import type { MiddlewareHandler } from 'hono';
import type { Clock } from '../../clock';
import type { Logger } from '../../logger';
import { validateInitData, type ValidatedInitData } from './init-data';

export interface AuthVariables {
  /** The caller's identity. The only trustworthy source of "who is calling". */
  auth: ValidatedInitData;
}

export interface InitDataAuthOptions {
  botToken: string;
  maxAgeSec: number;
  clockSkewSec: number;
  clock: Clock;
  logger: Logger;
}

const UNAUTHORIZED: ApiErrorBody = { error: 'unauthorized' };

/** Extracts the raw initData from `Authorization: tma <initData>`. */
export function parseAuthorizationHeader(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  if (space <= 0) return null;
  if (header.slice(0, space).toLowerCase() !== AUTH_SCHEME) return null;
  const raw = header.slice(space + 1).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Rejects every request without valid initData with 401. Never reads identity from the body,
 * query or other headers. Logs only the rejection reason, never the initData itself.
 */
export function initDataAuth(
  options: InitDataAuthOptions,
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const raw = parseAuthorizationHeader(c.req.header('authorization'));
    if (raw === null) {
      options.logger.info({ reason: 'missing_header' }, 'request rejected: unauthenticated');
      return c.json(UNAUTHORIZED, 401);
    }
    const result = validateInitData(raw, {
      botToken: options.botToken,
      now: options.clock.now(),
      maxAgeSec: options.maxAgeSec,
      clockSkewSec: options.clockSkewSec,
    });
    if (!result.ok) {
      options.logger.info({ reason: result.reason }, 'request rejected: unauthenticated');
      return c.json(UNAUTHORIZED, 401);
    }
    c.set('auth', result.data);
    await next();
  };
}
