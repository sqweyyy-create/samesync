/**
 * Tunable numbers of the game (PLAN.md Phase 3). Provisional unless a decided question says
 * otherwise, and passed in as data, like the matching parameters.
 */
export interface GameParams {
  /** Questions per game, the closing one included (Q3, provisional). */
  questionCount: number;
  /** A player who hasn't played gets one reminder this long before the game deadline (Q2). */
  reminderHoursBefore: number;
}

export const DEFAULT_GAME_PARAMS: GameParams = {
  questionCount: 5,
  reminderHoursBefore: 12,
};

/** Q2 (decided): once results are ready, the chat has 48 hours until the first message. */
export const CHAT_DEADLINE_HOURS = 48;
