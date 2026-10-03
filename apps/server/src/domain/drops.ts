/**
 * Matching drops (Q8, decided): each pool is matched at fixed local times, twice a day by default,
 * in Europe/Moscow for ru and UTC for en. Pure date arithmetic on top of Intl.
 */

export interface DropSchedule {
  /** Local times as `HH:MM`. */
  times: readonly string[];
  /** IANA time zone the times are in. */
  timeZone: string;
}

const MINUTE = 60_000;

/** Offset of `timeZone` from UTC at `at`, in milliseconds (positive east of Greenwich). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` shows the given local date and time. */
function zonedTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Guess with the offset at the wall time, then correct once (enough across DST changes).
  const guess = wall - zoneOffsetMs(new Date(wall), timeZone);
  return new Date(wall - zoneOffsetMs(new Date(guess), timeZone));
}

/** The most recent drop at or before `now`: today's or yesterday's latest scheduled time. */
export function latestDropSlot(now: Date, schedule: DropSchedule): Date {
  const local = new Date(now.getTime() + zoneOffsetMs(now, schedule.timeZone));
  let latest: Date | null = null;
  for (const dayShift of [0, -1]) {
    const day = new Date(local.getTime() + dayShift * 24 * 60 * MINUTE);
    for (const time of schedule.times) {
      const [hour, minute] = time.split(':').map(Number);
      const slot = zonedTimeToUtc(
        schedule.timeZone,
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        hour ?? 0,
        minute ?? 0,
      );
      if (slot.getTime() <= now.getTime() && (!latest || slot > latest)) latest = slot;
    }
  }
  if (!latest) throw new Error('a drop schedule needs at least one time');
  return latest;
}
