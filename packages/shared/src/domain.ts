/** Age bands (CLAUDE.md safety invariants). Derived from birth_date only, never stored as truth. */
export const BANDS = ['u18', 'adult'] as const;
export type Band = (typeof BANDS)[number];

export const MODES = ['friends', 'dating'] as const;
export type Mode = (typeof MODES)[number];
