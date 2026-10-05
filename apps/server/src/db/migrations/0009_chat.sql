CREATE TYPE "public"."message_verdict" AS ENUM('delivered', 'blocked_by_filter', 'rejected');--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"match_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text,
	"verdict" "message_verdict" NOT NULL,
	"reason" text,
	"sender_tg_message_id" bigint,
	"recipient_tg_message_id" bigint,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_sender_message_unique" UNIQUE("sender_id","sender_tg_message_id"),
	CONSTRAINT "messages_body_length" CHECK ("messages"."body" IS NULL OR char_length("messages"."body") BETWEEN 1 AND 2000),
	CONSTRAINT "messages_reason" CHECK (("messages"."verdict" = 'delivered') = ("messages"."reason" IS NULL)),
	CONSTRAINT "messages_delivered" CHECK ("messages"."delivered_at" IS NULL OR "messages"."verdict" = 'delivered'),
	CONSTRAINT "messages_recipient_message" CHECK ("messages"."recipient_tg_message_id" IS NULL OR "messages"."delivered_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "reveal_consents" (
	"match_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"revealed_at" timestamp with time zone,
	CONSTRAINT "reveal_consents_match_id_user_id_pk" PRIMARY KEY("match_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active_match_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reveal_consents" ADD CONSTRAINT "reveal_consents_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reveal_consents" ADD CONSTRAINT "reveal_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_match_idx" ON "messages" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_recipient_message_idx" ON "messages" USING btree ("recipient_tg_message_id");--> statement-breakpoint
CREATE INDEX "messages_sender_time_idx" ON "messages" USING btree ("sender_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_purge_idx" ON "messages" USING btree ("purge_after") WHERE "messages"."body" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_active_match_id_matches_id_fk" FOREIGN KEY ("active_match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_chat_deadline_idx" ON "matches" USING btree ("chat_deadline_at") WHERE "matches"."status" = 'results_ready';--> statement-breakpoint
-- Hand-written (not generated): nothing could move a match to `active` before this migration (the
-- chat arrives with it). Should a row claim it anyway, it has no first message and could never
-- expire: it is closed and its unsent notifications are dropped, the way migration 0006 closed
-- the matches made before the game.
UPDATE "outbox" SET "status" = 'cancelled', "cancel_reason" = 'admin'
WHERE "status" = 'pending'
  AND "match_id" IN (SELECT "id" FROM "matches" WHERE "status" = 'active');--> statement-breakpoint
UPDATE "matches" SET "status" = 'closed', "close_reason" = 'admin', "closed_at" = now()
WHERE "status" = 'active';--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_active_fields" CHECK ("matches"."status" <> 'active' OR ("matches"."first_message_at" IS NOT NULL AND "matches"."chat_deadline_at" IS NULL));