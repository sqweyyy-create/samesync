/**
 * SAFETY SUITE — a band change closes everything (CLAUDE.md invariant 4), and a freeze does too
 * (invariant 9). Covers the state-change trigger, the hourly age-transition job that fires it
 * after an 18th birthday, and what holds before that job has run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMatchesRepository } from '../../src/db/repositories/matches';
import { createUsersRepository } from '../../src/db/repositories/users';
import { createAgeTransition } from '../../src/jobs/age-transition';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { memoryLogger } from '../support/fixtures';
import {
  insertActiveUser,
  insertMatch,
  insertOutbox,
  matchRow,
  outboxRow,
  withoutTriggers,
} from '../support/matches';
import { birthDateYearsAgo, insertUser } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const born = (years: number, over = {}) =>
  insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(years), ...over });
const job = (u18PoolEnabled = false) =>
  createAgeTransition({
    users: createUsersRepository(testDb.db),
    u18PoolEnabled,
    logger: memoryLogger().logger,
  });
const matchesRepo = () => createMatchesRepository(testDb.db);
const admin = (userId: string, birthDate: string) =>
  testDb.ownerPool.query("SELECT admin_set_birth_date($1, $2::date, 777, 'age correction')", [
    userId,
    birthDate,
  ]);
const rejected = (rule: string) => ({ code: 'SS010', message: `match rejected: ${rule}` });

/** A 17-year-old with two open u18 matches, each with a pending notification for both users. */
async function seventeenWithMatches() {
  const user = await born(17);
  const friends = [await born(16), await born(17)];
  const matches = [];
  for (const friend of friends) {
    const match = await insertMatch(testDb.appPool, { a: user.id, b: friend.id, band: 'u18' });
    matches.push({
      ...match,
      friend,
      toUser: await insertOutbox(testDb.appPool, { userId: user.id, matchId: match.id }),
      toFriend: await insertOutbox(testDb.appPool, { userId: friend.id, matchId: match.id }),
    });
  }
  return { user, matches };
}

describe('a birth date corrected so that the user is 18 today (admin function)', () => {
  it('closes all their u18 matches with band_change and cancels the notifications of both sides', async () => {
    const { user, matches } = await seventeenWithMatches();
    // An unrelated u18 match must stay untouched.
    const [other1, other2] = [await born(15), await born(15)];
    const unrelated = await insertMatch(testDb.appPool, {
      a: other1.id,
      b: other2.id,
      band: 'u18',
    });

    await admin(user.id, birthDateYearsAgo(18));

    for (const match of matches) {
      const row = await matchRow(testDb.ownerPool, match.id);
      expect(row).toMatchObject({ status: 'closed', close_reason: 'band_change' });
      expect(row?.closed_at).not.toBeNull();
      for (const outbox of [match.toUser, match.toFriend]) {
        expect(await outboxRow(testDb.ownerPool, outbox.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'band_change',
        });
      }
    }
    expect(await matchRow(testDb.ownerPool, unrelated.id)).toMatchObject({
      status: 'pending_game',
    });
  });

  it('makes the match unreadable for both former participants', async () => {
    const { user, matches } = await seventeenWithMatches();
    const repo = matchesRepo();
    const [first] = matches;
    expect(await repo.getForParticipant(user.id, first!.id)).not.toBeNull();
    expect(await repo.listOpenForParticipant(first!.friend.id)).toHaveLength(1);

    await admin(user.id, birthDateYearsAgo(18));

    expect(await repo.getForParticipant(user.id, first!.id)).toBeNull();
    expect(await repo.getForParticipant(first!.friend.id, first!.id)).toBeNull();
    expect(await repo.listOpenForParticipant(user.id)).toEqual([]);
    expect(await repo.listOpenForParticipant(first!.friend.id)).toEqual([]);
  });

  it('works in the other direction: an adult corrected to u18 loses their adult matches', async () => {
    const [adult, partner] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: adult.id, b: partner.id });
    await admin(adult.id, birthDateYearsAgo(16));
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(await matchesRepo().getForParticipant(partner.id, match.id)).toBeNull();
  });

  it('closes matches for a correction inside the same band too (the two-year rule may break)', async () => {
    const [user, friend] = [await born(16), await born(16)];
    const match = await insertMatch(testDb.appPool, { a: user.id, b: friend.id, band: 'u18' });
    await admin(user.id, birthDateYearsAgo(15));
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
      status: 'closed',
      close_reason: 'admin',
    });
  });
});

describe('an 18th birthday', () => {
  /**
   * The state on the morning of the birthday: born exactly 18 years ago, the cached band still
   * u18, the u18 matches still open. Built with the triggers off (a test can't wait for midnight).
   */
  async function birthdayToday() {
    const state = await seventeenWithMatches();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [
        birthDateYearsAgo(18),
        state.user.id,
      ]),
    );
    return state;
  }

  it('before the job runs: the match trigger already refuses a new u18 match for them', async () => {
    const { user } = await birthdayToday();
    const kid = await born(17);
    await expect(
      insertMatch(testDb.appPool, { a: user.id, b: kid.id, band: 'u18' }),
    ).rejects.toMatchObject(rejected('band'));
  });

  it('before the job runs: their u18 matches are already unreadable for both sides', async () => {
    const { user, matches } = await birthdayToday();
    const repo = matchesRepo();
    expect(await matchRow(testDb.ownerPool, matches[0]!.id)).toMatchObject({
      status: 'pending_game',
    });
    expect(await repo.getForParticipant(user.id, matches[0]!.id)).toBeNull();
    expect(await repo.getForParticipant(matches[0]!.friend.id, matches[0]!.id)).toBeNull();
    expect(await repo.listOpenForParticipant(user.id)).toEqual([]);
  });

  it('the job reconciles the band, which closes the matches and cancels the notifications', async () => {
    const { user, matches } = await birthdayToday();
    const result = await job().run();
    expect(result.reconciled).toBeGreaterThanOrEqual(1);
    const { rows } = await testDb.ownerPool.query<{
      age_band: string;
      mode: string;
      status: string;
    }>('SELECT age_band, mode, status FROM users WHERE id = $1', [user.id]);
    // In the adult pool now, still in friends mode (dating is opt-in).
    expect(rows[0]).toEqual({ age_band: 'adult', mode: 'friends', status: 'active' });
    for (const match of matches) {
      expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
        status: 'closed',
        close_reason: 'band_change',
      });
      expect(await outboxRow(testDb.ownerPool, match.toFriend.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'band_change',
      });
    }
    // Nothing left to do on the next run.
    expect((await job().run()).reconciled).toBe(0);
  });

  it('any other write to the user has the same effect as the job', async () => {
    const { user, matches } = await birthdayToday();
    await testDb.appPool.query('UPDATE users SET last_active_at = now() WHERE id = $1', [user.id]);
    expect(await matchRow(testDb.ownerPool, matches[0]!.id)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
  });

  it('after the job they can be matched in the adult pool, and never again in u18', async () => {
    const { user } = await birthdayToday();
    await job().run();
    const adult = await born(19);
    await insertMatch(testDb.appPool, { a: user.id, b: adult.id, band: 'adult' });
    await expect(
      insertMatch(testDb.appPool, { a: user.id, b: (await born(17)).id, band: 'u18' }),
    ).rejects.toMatchObject(rejected('band'));
  });
});

describe('the waitlist', () => {
  const statusOf = async (id: string) =>
    (
      await testDb.ownerPool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
        id,
      ])
    ).rows[0]?.status;

  it('a waitlisted user who is an adult now becomes active; u18 users wait while their pool is off', async () => {
    const waitlisted = { status: 'waitlisted', mode: 'friends' as const, onboardedAt: new Date() };
    const nowAdult = await insertUser(testDb.appPool, {
      ...waitlisted,
      birthDate: birthDateYearsAgo(18),
    });
    const kid = await insertUser(testDb.appPool, {
      ...waitlisted,
      birthDate: birthDateYearsAgo(16),
    });
    expect((await job(false).run()).activated).toBe(1);
    expect(await statusOf(nowAdult.id)).toBe('active');
    expect(await statusOf(kid.id)).toBe('waitlisted');
    // Once the u18 pool is enabled, the waitlisted u18 users join it.
    expect((await job(true).run()).activated).toBe(1);
    expect(await statusOf(kid.id)).toBe('active');
  });

  it('never activates frozen, onboarding or ineligible users', async () => {
    const frozen = await born(30, { status: 'frozen' });
    const onboarding = await insertUser(testDb.appPool, { birthDate: birthDateYearsAgo(30) });
    await job(true).run();
    expect(await statusOf(frozen.id)).toBe('frozen');
    expect(await statusOf(onboarding.id)).toBe('onboarding');
  });
});

describe('a freeze or a deletion', () => {
  it.each(['frozen', 'deleted'] as const)(
    'status %s closes the open matches and cancels the notifications in the same transaction',
    async (status) => {
      const [user, partner, other] = [await born(25), await born(25), await born(25)];
      const open = await insertMatch(testDb.appPool, { a: user.id, b: partner.id });
      const closedBefore = await insertMatch(testDb.appPool, { a: user.id, b: other.id });
      await testDb.appPool.query(
        "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
        [closedBefore.id],
      );
      const toUser = await insertOutbox(testDb.appPool, { userId: user.id, matchId: open.id });
      const toPartner = await insertOutbox(testDb.appPool, {
        userId: partner.id,
        matchId: open.id,
      });

      // As the app role, like the Phase 5 freeze command will do it.
      await testDb.appPool.query('UPDATE users SET status = $1 WHERE id = $2', [status, user.id]);

      expect(await matchRow(testDb.ownerPool, open.id)).toMatchObject({
        status: 'closed',
        close_reason: status,
      });
      // A match that was already closed keeps its own reason.
      expect(await matchRow(testDb.ownerPool, closedBefore.id)).toMatchObject({
        close_reason: 'left',
      });
      for (const row of [toUser, toPartner]) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: status,
        });
      }
      await expect(
        insertMatch(testDb.appPool, { a: user.id, b: (await born(25)).id }),
      ).rejects.toMatchObject(rejected('not_active'));
    },
  );

  it('rolls back together: if the user update fails, no match is closed', async () => {
    const [user, partner] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: user.id, b: partner.id });
    const client = await testDb.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE users SET status = 'frozen' WHERE id = $1", [user.id]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({ status: 'pending_game' });
  });

  it('an unfreeze does not bring old matches back', async () => {
    const [user, partner] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: user.id, b: partner.id });
    await testDb.appPool.query("UPDATE users SET status = 'frozen' WHERE id = $1", [user.id]);
    await testDb.appPool.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });
  });

  it('other changes to a user leave their matches alone', async () => {
    const [user, partner] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: user.id, b: partner.id });
    await testDb.appPool.query(
      "UPDATE users SET locale = 'en', last_active_at = now(), bot_reachable = false WHERE id = $1",
      [user.id],
    );
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({ status: 'pending_game' });
  });
});
