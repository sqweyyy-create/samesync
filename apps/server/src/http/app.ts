import {
  CompleteRequest,
  MeResponse,
  SaveAnswersRequest,
  SaveInterestsRequest,
  SetBirthDateRequest,
  SetLocaleRequest,
  SetModeRequest,
  type ApiErrorBody,
} from '@samesync/shared/api';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type * as z from 'zod/mini';
import type { Clock } from '../clock';
import type { Logger } from '../logger';
import { ServiceError } from '../services/errors';
import type { ProfileService } from '../services/profile';
import { initDataAuth, type AuthVariables } from './auth/middleware';

export interface HttpAppDeps {
  botToken: string;
  initData: { maxAgeSec: number; clockSkewSec: number };
  clock: Clock;
  logger: Logger;
  profile: ProfileService;
}

const NOT_FOUND: ApiErrorBody = { error: 'not_found' };
const INTERNAL: ApiErrorBody = { error: 'internal' };
const MAX_QUERY_LENGTH = 64;

/** Parses and validates a JSON body; anything malformed is a 400 `invalid`. */
async function body<T extends z.ZodMiniType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ServiceError('invalid', ['body must be JSON']);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ServiceError(
      'invalid',
      result.error.issues.map((i) => i.path.join('.') || '(body)'),
    );
  }
  return result.data;
}

export function createHttpApp(deps: HttpAppDeps): Hono {
  const app = new Hono();
  const { profile } = deps;

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

  api.get('/me', async (c) => c.json(MeResponse.parse(await profile.me(c.get('auth')))));

  const setLocale = async (c: Context<{ Variables: AuthVariables }>) => {
    const { locale } = await body(c, SetLocaleRequest);
    return c.json(await profile.setLocale(c.get('auth'), locale));
  };
  api.post('/onboarding/locale', setLocale);
  api.put('/profile/locale', setLocale);

  api.post('/onboarding/birth-date', async (c) => {
    const { birthDate } = await body(c, SetBirthDateRequest);
    return c.json(await profile.setBirthDate(c.get('auth'), birthDate));
  });

  const setMode = async (c: Context<{ Variables: AuthVariables }>) =>
    c.json(await profile.setMode(c.get('auth'), await body(c, SetModeRequest)));
  api.post('/onboarding/mode', setMode);
  api.put('/profile/mode', setMode);

  api.get('/dating-options', async (c) => c.json(await profile.datingOptions(c.get('auth'))));

  api.get('/deck', async (c) => c.json(await profile.deck(c.get('auth'))));

  api.put('/profile/answers', async (c) => {
    const { answers } = await body(c, SaveAnswersRequest);
    return c.json(await profile.saveAnswers(c.get('auth'), answers));
  });

  api.get('/interests', async (c) => {
    const domain = c.req.query('domain');
    const q = c.req.query('q');
    if (q !== undefined && q.length > MAX_QUERY_LENGTH) throw new ServiceError('invalid', ['q']);
    return c.json(
      await profile.interests(c.get('auth'), {
        ...(domain ? { domain } : {}),
        ...(q ? { q } : {}),
      }),
    );
  });

  api.put('/profile/interests', async (c) => {
    const { itemIds } = await body(c, SaveInterestsRequest);
    return c.json(await profile.saveInterests(c.get('auth'), itemIds));
  });

  api.post('/onboarding/complete', async (c) =>
    c.json(await profile.complete(c.get('auth'), await body(c, CompleteRequest))),
  );

  app.route('/api', api);

  app.notFound((c) => c.json(NOT_FOUND, 404));
  app.onError((error, c) => {
    if (error instanceof ServiceError) {
      const payload: ApiErrorBody = error.details
        ? { error: error.code, details: error.details }
        : { error: error.code };
      return c.json(payload, error.status as ContentfulStatusCode);
    }
    deps.logger.error({ err: error, path: c.req.path }, 'unhandled http error');
    return c.json(INTERNAL, 500);
  });
  return app;
}
