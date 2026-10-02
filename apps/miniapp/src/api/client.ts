import { AUTH_SCHEME, MeResponse } from '@samesync/shared/api';

export type ApiResult<T> = { kind: 'ok'; data: T } | { kind: 'unauthorized' } | { kind: 'network' };

export interface ApiClient {
  readonly getMe: () => Promise<ApiResult<MeResponse>>;
}

export interface ApiClientDeps {
  getInitData: () => string | undefined;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const doFetch = deps.fetch ?? fetch.bind(globalThis);
  const base = deps.baseUrl ?? '';

  return {
    async getMe() {
      const initData = deps.getInitData();
      if (!initData) return { kind: 'unauthorized' };
      let response: Response;
      try {
        response = await doFetch(`${base}/api/me`, {
          headers: { Authorization: `${AUTH_SCHEME} ${initData}` },
        });
      } catch {
        return { kind: 'network' };
      }
      if (response.status === 401) return { kind: 'unauthorized' };
      if (!response.ok) return { kind: 'network' };
      const parsed = MeResponse.safeParse(await response.json());
      return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'network' };
    },
  };
}
