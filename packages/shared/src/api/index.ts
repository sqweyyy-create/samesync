/**
 * HTTP API contract shared by the server and the Mini App.
 * Uses zod/mini to keep the Mini App bundle small.
 */
import * as z from 'zod/mini';
import { LOCALES } from '../locale';

/** Authorization header scheme: `Authorization: tma <raw initData>`. */
export const AUTH_SCHEME = 'tma';

export const ApiErrorCode = z.enum(['unauthorized', 'not_found', 'internal']);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorBody = z.object({ error: ApiErrorCode });
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

export const MeResponse = z.object({
  publicId: z.string(),
  firstName: z.string(),
  locale: z.enum(LOCALES),
});
export type MeResponse = z.infer<typeof MeResponse>;
