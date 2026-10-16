CREATE TYPE "public"."filter_event_kind" AS ENUM('url', 'handle', 'phone', 'email', 'social', 'non_text');--> statement-breakpoint
CREATE TYPE "public"."report_reason" AS ENUM('spam', 'harassment', 'sexual', 'age_misrepresentation', 'contact_sharing', 'other');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'dismissed', 'actioned');--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'account_frozen';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'support_reply';--> statement-breakpoint
CREATE TABLE "filter_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"match_id" uuid,
	"kind" "filter_event_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "reports_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"reporter_id" uuid,
	"reported_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"reason" "report_reason" NOT NULL,
	"note" text,
	"evidence" jsonb,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"resolved_by" bigint,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_reporter_match_unique" UNIQUE("reporter_id","reported_id","match_id"),
	CONSTRAINT "reports_not_self" CHECK ("reports"."reporter_id" IS NULL OR "reports"."reporter_id" <> "reports"."reported_id"),
	CONSTRAINT "reports_resolution" CHECK (("reports"."status" = 'open') = ("reports"."resolved_at" IS NULL) AND ("reports"."status" = 'open') = ("reports"."resolved_by" IS NULL)),
	CONSTRAINT "reports_note_length" CHECK ("reports"."note" IS NULL OR char_length("reports"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "filter_events" ADD CONSTRAINT "filter_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_events" ADD CONSTRAINT "filter_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reported_id_users_id_fk" FOREIGN KEY ("reported_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "filter_events_user_time_idx" ON "filter_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_reported_idx" ON "reports" USING btree ("reported_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_open_idx" ON "reports" USING btree ("created_at") WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "reports_match_idx" ON "reports" USING btree ("match_id");--> statement-breakpoint
-- Hand-written (not generated): least privilege for the new tables (PLAN.md §3 layer 6).
-- A report is written once and then only resolved, or stripped of its evidence when the retention
-- period is over (Q20). A filter event is a counter: written, never changed. Neither can be
-- deleted by the app.
GRANT SELECT, INSERT ON reports TO samesync_app;--> statement-breakpoint
GRANT UPDATE (status, resolved_by, resolved_at, evidence) ON reports TO samesync_app;--> statement-breakpoint
GRANT SELECT, INSERT ON filter_events TO samesync_app;--> statement-breakpoint
-- Blocks are written from Phase 5 (they were only read before). Never removed: a block is for good.
GRANT INSERT ON blocks TO samesync_app;
