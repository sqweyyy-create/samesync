import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { contentReleases, interestItems, questions } from './content';
import { answerValueEnum } from './enums';
import { users } from './users';

export const answers = pgTable(
  'answers',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id),
    value: answerValueEnum('value').notNull(),
    /** The content release the answer was given under. */
    contentRelease: text('content_release')
      .notNull()
      .references(() => contentReleases.version),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.questionId] }),
    index('answers_question_value_idx').on(t.questionId, t.value),
  ],
);

export const userInterests = pgTable(
  'user_interests',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemId: text('item_id')
      .notNull()
      .references(() => interestItems.id),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.itemId] }),
    index('user_interests_item_idx').on(t.itemId),
  ],
);
