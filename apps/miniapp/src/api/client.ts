import type { Locale } from '@samesync/shared';
import {
  ApiErrorBody,
  AUTH_SCHEME,
  DatingOptionsResponse,
  DeckResponse,
  GameResponse,
  InterestsResponse,
  MatchSummary,
  MatchesResponse,
  MeResponse,
  ReportResponse,
  ResultsResponse,
  type AnswerValue,
  type ApiErrorCode,
  type PredictionsRequest,
  type ReportRequest,
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
  /** The takes of a match's game to guess. Never anyone's answers. */
  readonly game: (matchId: string) => Promise<ApiResult<GameResponse>>;
  /** All guesses at once; they can't be changed afterwards. Answers with the updated match. */
  readonly submitPredictions: (
    matchId: string,
    predictions: PredictionsRequest['predictions'],
  ) => Promise<ApiResult<MatchSummary>>;
  readonly results: (matchId: string) => Promise<ApiResult<ResultsResponse>>;
  /**
   * Sends a message to the other person of a match through the bot (the opener, as the first
   * message of the chat). Answers with the updated match, never with the message.
   */
  readonly sendMessage: (matchId: string, text: string) => Promise<ApiResult<MatchSummary>>;
  /** Reports the other person of a match (Phase 5). */
  readonly report: (matchId: string, request: ReportRequest) => Promise<ApiResult<ReportResponse>>;
  /** Blocks the other person of a match: the chat ends, the pair is never matched again. */
  readonly block: (matchId: string) => Promise<ApiResult<MatchSummary>>;
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
    game: (id) => call(GameResponse, 'GET', `/api/matches/${encodeURIComponent(id)}/game`),
    submitPredictions: (id, predictions) =>
      call(MatchSummary, 'PUT', `/api/matches/${encodeURIComponent(id)}/predictions`, {
        predictions,
      }),
    results: (id) => call(ResultsResponse, 'GET', `/api/matches/${encodeURIComponent(id)}/results`),
    sendMessage: (id, text) =>
      call(MatchSummary, 'POST', `/api/matches/${encodeURIComponent(id)}/messages`, { text }),
    report: (id, request) =>
      call(ReportResponse, 'POST', `/api/matches/${encodeURIComponent(id)}/report`, request),
    block: (id) => call(MatchSummary, 'POST', `/api/matches/${encodeURIComponent(id)}/block`),
  };
}
