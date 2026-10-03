import type { Locale } from '@samesync/shared';
import {
  ApiErrorBody,
  AUTH_SCHEME,
  DatingOptionsResponse,
  DeckResponse,
  InterestsResponse,
  MatchSummary,
  MatchesResponse,
  MeResponse,
  type AnswerValue,
  type ApiErrorCode,
  type SetModeRequest,
} from '@samesync/shared/api';

/** Anything with zod's safeParse (the shared schemas), without depending on zod here. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type ApiResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'error'; code: ApiErrorCode; details: string[] }
  | { kind: 'unauthorized' }
  | { kind: 'network' };

export interface ApiClient {
  readonly getMe: () => Promise<ApiResult<MeResponse>>;
  readonly setLocale: (locale: Locale) => Promise<ApiResult<MeResponse>>;
  readonly setBirthDate: (birthDate: string) => Promise<ApiResult<MeResponse>>;
  readonly setMode: (request: SetModeRequest) => Promise<ApiResult<MeResponse>>;
  readonly datingOptions: () => Promise<ApiResult<DatingOptionsResponse>>;
  readonly deck: () => Promise<ApiResult<DeckResponse>>;
  readonly saveAnswers: (
    answers: Array<{ questionId: string; value: AnswerValue }>,
  ) => Promise<ApiResult<MeResponse>>;
  readonly interests: (filter: {
    domain?: string;
    q?: string;
  }) => Promise<ApiResult<InterestsResponse>>;
  readonly saveInterests: (itemIds: string[]) => Promise<ApiResult<MeResponse>>;
  readonly complete: (timezone: string | undefined) => Promise<ApiResult<MeResponse>>;
  readonly matches: () => Promise<ApiResult<MatchesResponse>>;
  readonly match: (id: string) => Promise<ApiResult<MatchSummary>>;
}

export interface ApiClientDeps {
  getInitData: () => string | undefined;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  const base = deps.baseUrl ?? '';

  async function call<T>(
    schema: Schema<T>,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    const initData = deps.getInitData();
    if (!initData) return { kind: 'unauthorized' };
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `${AUTH_SCHEME} ${initData}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { kind: 'network' };
    }
    if (response.status === 401) return { kind: 'unauthorized' };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { kind: 'network' };
    }
    if (!response.ok) {
      const error = ApiErrorBody.safeParse(json);
      return error.success
        ? { kind: 'error', code: error.data.error, details: error.data.details ?? [] }
        : { kind: 'network' };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'network' };
  }

  const query = (filter: { domain?: string; q?: string }) => {
    const params = new URLSearchParams();
    if (filter.domain) params.set('domain', filter.domain);
    if (filter.q) params.set('q', filter.q);
    const text = params.toString();
    return text ? `?${text}` : '';
  };

  return {
    getMe: () => call(MeResponse, 'GET', '/api/me'),
    setLocale: (locale) => call(MeResponse, 'PUT', '/api/profile/locale', { locale }),
    setBirthDate: (birthDate) =>
      call(MeResponse, 'POST', '/api/onboarding/birth-date', { birthDate }),
    setMode: (request) => call(MeResponse, 'PUT', '/api/profile/mode', request),
    datingOptions: () => call(DatingOptionsResponse, 'GET', '/api/dating-options'),
    deck: () => call(DeckResponse, 'GET', '/api/deck'),
    saveAnswers: (answers) => call(MeResponse, 'PUT', '/api/profile/answers', { answers }),
    interests: (filter) => call(InterestsResponse, 'GET', `/api/interests${query(filter)}`),
    saveInterests: (itemIds) => call(MeResponse, 'PUT', '/api/profile/interests', { itemIds }),
    complete: (timezone) =>
      call(MeResponse, 'POST', '/api/onboarding/complete', timezone ? { timezone } : {}),
    matches: () => call(MatchesResponse, 'GET', '/api/matches'),
    match: (id) => call(MatchSummary, 'GET', `/api/matches/${encodeURIComponent(id)}`),
  };
}
