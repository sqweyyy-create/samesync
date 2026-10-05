import type { ApiErrorCode } from '@samesync/shared/api';

type Status = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

const STATUS: Record<ApiErrorCode, Status> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  out_of_order: 409,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

/** An expected failure with an API error code; HTTP handlers turn it into a JSON response. */
export class ServiceError extends Error {
  override name = 'ServiceError';
  readonly status: Status;

  constructor(
    readonly code: ApiErrorCode,
    readonly details?: string[],
  ) {
    super(code);
    this.status = STATUS[code];
  }
}
