import type { AnswerValue } from '@samesync/shared/api';
import { and, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { answers, userInterests } from '../schema/index';

/** The caller's own answers and interests. Every method is scoped to one user ID. */
export interface ProfileRepository {
  answersOf(userId: string): Promise<Map<string, AnswerValue>>;
  saveAnswers(
    userId: string,
    entries: ReadonlyArray<{ questionId: string; value: AnswerValue }>,
    release: string,
    now: Date,
  ): Promise<void>;
  /** Non-skip answers among `questionIds` (the takes in the user's current deck scope). */
  countAnswered(userId: string, questionIds: readonly string[]): Promise<number>;
  interestsOf(userId: string): Promise<string[]>;
  /** Replaces the whole set in one transaction. */
  replaceInterests(userId: string, itemIds: readonly string[], now: Date): Promise<void>;
}

export function createProfileRepository(db: Db): ProfileRepository {
  return {
    async answersOf(userId) {
      const rows = await db
        .select({ questionId: answers.questionId, value: answers.value })
        .from(answers)
        .where(eq(answers.userId, userId));
      return new Map(rows.map((r) => [r.questionId, r.value]));
    },

    async saveAnswers(userId, entries, release, now) {
      if (entries.length === 0) return;
      await db
        .insert(answers)
        .values(
          entries.map((e) => ({
            userId,
            questionId: e.questionId,
            value: e.value,
            contentRelease: release,
            answeredAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [answers.userId, answers.questionId],
          set: {
            value: sql`excluded.value`,
            contentRelease: sql`excluded.content_release`,
            answeredAt: sql`excluded.answered_at`,
          },
        });
    },

    async countAnswered(userId, questionIds) {
      if (questionIds.length === 0) return 0;
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(answers)
        .where(
          and(
            eq(answers.userId, userId),
            ne(answers.value, 'skip'),
            inArray(answers.questionId, [...questionIds]),
          ),
        );
      return row?.n ?? 0;
    },

    async interestsOf(userId) {
      const rows = await db
        .select({ itemId: userInterests.itemId })
        .from(userInterests)
        .where(eq(userInterests.userId, userId));
      return rows.map((r) => r.itemId).sort();
    },

    async replaceInterests(userId, itemIds, now) {
      // Keeps added_at for picks that stay; removes only what was unpicked.
      await db.transaction(async (tx) => {
        await tx
          .delete(userInterests)
          .where(
            and(
              eq(userInterests.userId, userId),
              itemIds.length > 0 ? notInArray(userInterests.itemId, [...itemIds]) : undefined,
            ),
          );
        if (itemIds.length > 0) {
          await tx
            .insert(userInterests)
            .values(itemIds.map((itemId) => ({ userId, itemId, addedAt: now })))
            .onConflictDoNothing();
        }
      });
    },
  };
}
