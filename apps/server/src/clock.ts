/** The only source of "now" for domain and service code (CLAUDE.md: inject a Clock). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date): Clock & { set(next: Date): void } {
  let current = at;
  return {
    now: () => current,
    set(next) {
      current = next;
    },
  };
}
