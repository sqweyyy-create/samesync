/**
 * HTTP API contract shared by the server and the Mini App.
 * Uses zod/mini to keep the Mini App bundle small.
 */
import * as z from 'zod/mini';
import { ADULT_AGE, MAX_AGE } from '../age';
import { BANDS, MATCH_STATUSES, MODES } from '../domain';
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
  /** Too many requests of this kind in a short time. */
  'rate_limited',
  /** Something we depend on (Telegram) did not answer: trying again later may work. */
  'unavailable',
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

/**
 * One of the caller's matches. The other person appears only under their per-match alias: no
 * name, username or ID of theirs is ever part of an API response.
 */
export const MatchSummary = z.object({
  id: z.string(),
  alias: z.object({ emoji: z.string(), name: z.string() }),
  /** What the two share, rendered in the caller's language. */
  teaser: z.string(),
  status: z.enum(MATCH_STATUSES),
  createdAt: z.string(),
  /** The game can be played until then (Q2: 48 hours from the match). */
  gameDeadlineAt: z.string(),
  /** When both had finished the game, and until when the chat stays open without a message. */
  resultsReadyAt: z.nullable(z.string()),
  chatDeadlineAt: z.nullable(z.string()),
  /**
   * How far the game is: its size and who has submitted their guesses. Never an answer or a
   * guess. Null for a match that has no game.
   */
  game: z.nullable(
    z.object({ questions: z.number(), youDone: z.boolean(), theyDone: z.boolean() }),
  ),
  /**
   * Whether this match can have a chat at all. The chat itself is open while the status is
   * `results_ready` (nobody has written yet) or `active`, and it takes place in the bot.
   */
  chat: z.boolean(),
});
export type MatchSummary = z.infer<typeof MatchSummary>;

export const MatchesResponse = z.object({ matches: z.array(MatchSummary) });
export type MatchesResponse = z.infer<typeof MatchesResponse>;

/** A side of a take. A game never contains a skip. */
export const Side = z.enum(['agree', 'disagree']);
export type Side = z.infer<typeof Side>;

/**
 * The game as a player sees it before the results: the takes to guess, in that player's own
 * order. It never carries an answer, of the caller or of the other person.
 */
export const GameResponse = z.object({
  questions: z.array(z.object({ id: z.string(), text: z.string() })),
});
export type GameResponse = z.infer<typeof GameResponse>;

/** All guesses of one player, sent once: one per question of the game. */
export const PredictionsRequest = z.object({
  predictions: z
    .array(z.object({ questionId: ContentId, value: Side }))
    .check(z.minLength(1), z.maxLength(50)),
});
export type PredictionsRequest = z.infer<typeof PredictionsRequest>;

/** Longest chat message, in characters (the server counts code points). */
export const MESSAGE_MAX_LENGTH = 2000;

/** A message written in the Mini App: the opener, sent as the first message of the chat. */
export const SendMessageRequest = z.object({
  text: z.string().check(z.minLength(1), z.maxLength(2 * MESSAGE_MAX_LENGTH)),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** Why someone reports the other person of a match (PLAN.md Phase 5). */
export const ReportReason = z.enum([
  'spam',
  'harassment',
  'sexual',
  'age_misrepresentation',
  'contact_sharing',
  'other',
]);
export type ReportReason = z.infer<typeof ReportReason>;

export const REPORT_NOTE_MAX_LENGTH = 500;

/** `POST /api/matches/:id/report`: a report about the other person of the match. */
export const ReportRequest = z.object({
  reason: ReportReason,
  note: z.optional(z.string().check(z.maxLength(REPORT_NOTE_MAX_LENGTH))),
});
export type ReportRequest = z.infer<typeof ReportRequest>;

/** `duplicate`: the caller reported this match before; nothing new is counted. */
export const ReportResponse = z.object({ status: z.enum(['stored', 'duplicate']) });
export type ReportResponse = z.infer<typeof ReportResponse>;

/** The results of a finished game. They exist only once both players have submitted. */
export const ResultsResponse = z.object({
  total: z.number(),
  /** How many of the other person's answers the caller guessed, and the other way round. */
  youGuessed: z.number(),
  theyGuessed: z.number(),
  /** Every question with both answers and both guesses. The last one is the closing question. */
  rounds: z.array(
    z.object({
      questionId: z.string(),
      text: z.string(),
      yours: Side,
      theirs: Side,
      yourGuess: Side,
      theirGuess: Side,
    }),
  ),
  /** The suggested first message about the closing question, in the language of the match. */
  opener: z.string(),
});
export type ResultsResponse = z.infer<typeof ResultsResponse>;
