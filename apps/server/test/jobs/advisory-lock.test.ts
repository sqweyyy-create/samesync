import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCK, withAdvisoryLock } from '../../src/jobs/advisory-lock';
import { createTestDatabase, type TestDatabase } from '../support/db';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

describe('withAdvisoryLock', () => {
  it('lets one holder in at a time and frees the lock afterwards', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withAdvisoryLock(testDb.appPool, LOCK.outbox, async () => {
      entered();
      await held;
      return 'first';
    });
    await inside;
    expect(
      await withAdvisoryLock(testDb.appPool, LOCK.outbox, () => Promise.resolve('second')),
    ).toEqual({ acquired: false });
    // A different job is not affected.
    expect(
      await withAdvisoryLock(testDb.appPool, LOCK.ageTransition, () => Promise.resolve('other')),
    ).toEqual({ acquired: true, value: 'other' });
    release();
    expect(await first).toEqual({ acquired: true, value: 'first' });
    expect(
      await withAdvisoryLock(testDb.appPool, LOCK.outbox, () => Promise.resolve('third')),
    ).toEqual({ acquired: true, value: 'third' });
  });

  it('frees the lock when the job throws', async () => {
    await expect(
      withAdvisoryLock(testDb.appPool, LOCK.outbox, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(await withAdvisoryLock(testDb.appPool, LOCK.outbox, () => Promise.resolve(1))).toEqual({
      acquired: true,
      value: 1,
    });
  });

  it('gives every pool × mode its own matching lock', () => {
    const keys = [
      LOCK.matching({ band: 'u18', locale: 'ru' }, 'friends'),
      LOCK.matching({ band: 'u18', locale: 'en' }, 'friends'),
      LOCK.matching({ band: 'adult', locale: 'ru' }, 'friends'),
      LOCK.matching({ band: 'adult', locale: 'ru' }, 'dating'),
      LOCK.matching({ band: 'adult', locale: 'en' }, 'friends'),
      LOCK.matching({ band: 'adult', locale: 'en' }, 'dating'),
      LOCK.outbox,
      LOCK.ageTransition,
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
