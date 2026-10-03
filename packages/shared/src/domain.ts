/** Age bands (CLAUDE.md safety invariants). Derived from birth_date only, never stored as truth. */
export const BANDS = ['u18', 'adult'] as const;
export type Band = (typeof BANDS)[number];

export const MODES = ['friends', 'dating'] as const;
export type Mode = (typeof MODES)[number];

/** Match lifecycle (PLAN.md §1). `expired` and `closed` are final. */
export const MATCH_STATUSES = [
  'pending_game',
  'results_ready',
  'active',
  'expired',
  'closed',
] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** A match in one of these states is open: it counts toward limits and can still be used. */
export const OPEN_MATCH_STATUSES = ['pending_game', 'results_ready', 'active'] as const;

export const MATCH_CLOSE_REASONS = [
  'expired',
  'blocked',
  'reported',
  'frozen',
  'band_change',
  'left',
  'admin',
  'deleted',
] as const;
export type MatchCloseReason = (typeof MATCH_CLOSE_REASONS)[number];
