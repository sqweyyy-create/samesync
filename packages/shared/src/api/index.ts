/**
 * HTTP API contract shared by the server and the Mini App.
 * Uses zod/mini to keep the Mini App bundle small.
 */
import * as z from 'zod/mini';
import { ADULT_AGE, MAX_AGE } from '../age';
import { BANDS, MODES } from '../domain';
import { LOCALES } from '../locale';

/** Authorization header scheme: `Authorization: tma <raw initData>`. */
export const AUTH_SCHEME = 'tma';

export const ApiErrorCode = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'out_of_order',
  'invalid',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCode>;

export const ApiErrorBody = z.object({
  error: ApiErrorCode,
  details: z.optional(z.array(z.string())),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Onboarding limits (PLAN.md Q5/Q6, decided). */
export const ONBOARDING = {
  deckSize: 35,
  minAnswers: 25,
  minInterests: 5,
  maxInterests: 30,
} as const;

export const OnboardingStep = z.enum([
  'locale',
  'birth_date',
  'ineligible',
  'mode',
  'answers',
  'interests',
  'finish',
  'done',
]);
export type OnboardingStep = z.infer<typeof OnboardingStep>;

export const UserStatus = z.enum([
  'onboarding',
  'active',
  'waitlisted',
  'ineligible',
  'frozen',
  'deleted',
]);
export type UserStatus = z.infer<typeof UserStatus>;

const Locale = z.enum(LOCALES);
const Mode = z.enum(MODES);
const ContentId = z.string().check(z.maxLength(80));
const IsoDate = z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/));
/** A partner age in dating mode (Q12): whole years, adults only. */
const PartnerAge = z.int().check(z.gte(ADULT_AGE), z.lte(MAX_AGE));

export const MeResponse = z.object({
  publicId: z.string(),
  firstName: z.string(),
  locale: Locale,
  status: UserStatus,
  step: OnboardingStep,
  birthDate: z.nullable(z.string()),
  age: z.nullable(z.number()),
  band: z.nullable(z.enum(BANDS)),
  mode: z.nullable(Mode),
  gender: z.nullable(z.string()),
  seeking: z.nullable(z.array(z.string())),
  /** Partner age range in dating mode (Q12); null in friends mode. */
  datingAgeMin: z.nullable(z.number()),
  datingAgeMax: z.nullable(z.number()),
  progress: z.object({ answered: z.number(), interests: z.number() }),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SetLocaleRequest = z.object({ locale: Locale });
export type SetLocaleRequest = z.infer<typeof SetLocaleRequest>;

export const SetBirthDateRequest = z.object({ birthDate: IsoDate });
export type SetBirthDateRequest = z.infer<typeof SetBirthDateRequest>;

export const SetModeRequest = z.object({
  mode: Mode,
  gender: z.optional(ContentId),
  seeking: z.optional(z.array(ContentId).check(z.maxLength(10))),
  /** Dating only (Q12). Left out, the server keeps the stored range or applies the default. */
  ageMin: z.optional(PartnerAge),
  ageMax: z.optional(PartnerAge),
});
export type SetModeRequest = z.infer<typeof SetModeRequest>;

export const AnswerValue = z.enum(['agree', 'disagree', 'skip']);
export type AnswerValue = z.infer<typeof AnswerValue>;

export const DeckResponse = z.object({
  questions: z.array(z.object({ id: z.string(), text: z.string() })),
  answers: z.array(z.object({ questionId: z.string(), value: AnswerValue })),
});
export type DeckResponse = z.infer<typeof DeckResponse>;

export const SaveAnswersRequest = z.object({
  answers: z
    .array(z.object({ questionId: ContentId, value: AnswerValue }))
    .check(z.minLength(1), z.maxLength(50)),
});
export type SaveAnswersRequest = z.infer<typeof SaveAnswersRequest>;

export const InterestsResponse = z.object({
  items: z.array(
    z.object({ id: z.string(), name: z.string(), categoryName: z.string(), domain: z.string() }),
  ),
  selected: z.array(z.string()),
});
export type InterestsResponse = z.infer<typeof InterestsResponse>;

export const SaveInterestsRequest = z.object({
  itemIds: z.array(ContentId).check(z.maxLength(ONBOARDING.maxInterests)),
});
export type SaveInterestsRequest = z.infer<typeof SaveInterestsRequest>;

export const DatingOptionsResponse = z.object({
  options: z.array(z.object({ id: z.string(), self: z.string(), seeking: z.string() })),
});
export type DatingOptionsResponse = z.infer<typeof DatingOptionsResponse>;

export const CompleteRequest = z.object({
  timezone: z.optional(z.string().check(z.maxLength(64))),
});
export type CompleteRequest = z.infer<typeof CompleteRequest>;
