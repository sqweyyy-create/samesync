/** The fields of a Postgres error we act on. Drivers and Drizzle wrap it in `cause` chains. */
export interface PgError {
  code: string;
  message: string;
  constraint?: string;
}

/** Finds the Postgres error inside `error` (or its causes), if there is one. */
export function pgErrorOf(error: unknown): PgError | null {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    const candidate = e as Error & { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return {
        code: candidate.code,
        message: candidate.message,
        ...(typeof candidate.constraint === 'string' ? { constraint: candidate.constraint } : {}),
      };
    }
  }
  return null;
}
