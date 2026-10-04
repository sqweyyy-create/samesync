ALTER TYPE "public"."outbox_kind" ADD VALUE 'game_turn';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'game_results';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'game_reminder';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'game_expired';--> statement-breakpoint
CREATE TABLE "game_predictions" (
	"match_id" uuid NOT NULL,
	"predictor_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"predicted" "answer_value" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_predictions_match_id_predictor_id_question_id_pk" PRIMARY KEY("match_id","predictor_id","question_id"),
	CONSTRAINT "game_predictions_no_skip" CHECK ("game_predictions"."predicted" <> 'skip')
);
--> statement-breakpoint
-- Hand-written (not generated): matches made before Phase 3 only have a game shell without
-- questions, so they can never be played. The ones still open are closed, their unsent
-- notifications are dropped, and the empty shells are removed: from here on every row of "games"
-- has its questions (the columns below are NOT NULL).
UPDATE "outbox" SET "status" = 'cancelled', "cancel_reason" = 'admin'
WHERE "status" = 'pending'
  AND "match_id" IN (SELECT "id" FROM "matches" WHERE "status" IN ('pending_game', 'results_ready', 'active'));--> statement-breakpoint
UPDATE "matches" SET "status" = 'closed', "close_reason" = 'admin', "closed_at" = now()
WHERE "status" IN ('pending_game', 'results_ready', 'active');--> statement-breakpoint
DELETE FROM "games";--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "question_ids" text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "closing_question_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "answers_a" "answer_value"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "answers_b" "answer_value"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "a_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "games" ADD COLUMN "b_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "game_predictions" ADD CONSTRAINT "game_predictions_match_id_games_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."games"("match_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_predictions" ADD CONSTRAINT "game_predictions_predictor_id_users_id_fk" FOREIGN KEY ("predictor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_predictions" ADD CONSTRAINT "game_predictions_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_closing_question_id_questions_id_fk" FOREIGN KEY ("closing_question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_answers_aligned" CHECK (cardinality("games"."question_ids") BETWEEN 1 AND 50 AND cardinality("games"."answers_a") = cardinality("games"."question_ids") AND cardinality("games"."answers_b") = cardinality("games"."question_ids"));--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_answers_complete" CHECK (array_position("games"."question_ids", NULL) IS NULL AND array_position("games"."answers_a", NULL) IS NULL AND array_position("games"."answers_b", NULL) IS NULL AND array_position("games"."answers_a", 'skip') IS NULL AND array_position("games"."answers_b", 'skip') IS NULL);--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_closing_split" CHECK ("games"."closing_question_id" = "games"."question_ids"[cardinality("games"."question_ids")] AND "games"."answers_a"[cardinality("games"."answers_a")] <> "games"."answers_b"[cardinality("games"."answers_b")]);--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_results_ready_fields" CHECK ("matches"."status" <> 'results_ready' OR ("matches"."results_ready_at" IS NOT NULL AND "matches"."chat_deadline_at" IS NOT NULL));