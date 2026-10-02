import { MeResponse, type ApiErrorBody } from '@samesync/shared/api';
import { Hono } from 'hono';
import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { SessionService } from '../services/session';
import { initDataAuth, type AuthVariables } from './auth/middleware';

export interface HttpAppDeps {
  botToken: string;
  initData: { maxAgeSec: number; clockSkewSec: number };
  clock: Clock;
  logger: Logger;
  session: SessionService;
}

const NOT_FOUND: ApiErrorBody = { error: 'not_found' };
const INTERNAL: ApiErrorBody = { error: 'internal' };

export function createHttpApp(deps: HttpAppDeps): Hono {
  const app = new Hono();

  // Request log: method, path without query, status, duration. Never headers or bodies.
  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    deps.logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'http request',
    );
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  const api = new Hono<{ Variables: AuthVariables }>();
  api.use(
    initDataAuth({
      botToken: deps.botToken,
      maxAgeSec: deps.initData.maxAgeSec,
      clockSkewSec: deps.initData.clockSkewSec,
      clock: deps.clock,
      logger: deps.logger,
    }),
  );
  api.get('/me', async (c) => c.json(MeResponse.parse(await deps.session.me(c.get('auth')))));
  app.route('/api', api);

  app.notFound((c) => c.json(NOT_FOUND, 404));
  app.onError((error, c) => {
    deps.logger.error({ err: error, path: c.req.path }, 'unhandled http error');
    return c.json(INTERNAL, 500);
  });
  return app;
}
