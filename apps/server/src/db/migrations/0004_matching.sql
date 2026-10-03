CREATE TYPE "public"."match_close_reason" AS ENUM('expired', 'blocked', 'reported', 'frozen', 'band_change', 'left', 'admin', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending_game', 'results_ready', 'active', 'expired', 'closed');--> statement-breakpoint
CREATE TYPE "public"."outbox_kind" AS ENUM('match_created');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"match_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "blocks_not_self" CHECK ("blocks"."blocker_id" <> "blocks"."blocked_id")
);
--> statement-breakpoint
CREATE TABLE "feature_stats" (
	"band" "band" NOT NULL,
	"locale" "locale" NOT NULL,
	"feature_key" text NOT NULL,
	"n_users" integer NOT NULL,
	"pool_size" integer NOT NULL,
	"weight" double precision NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "feature_stats_band_locale_feature_key_pk" PRIMARY KEY("band","locale","feature_key")
);
--> statement-breakpoint
CREATE TABLE "games" (
	"match_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"band" "band" NOT NULL,
	"locale" "locale" NOT NULL,
	"mode" "mode" NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"seed" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"pool_size" integer,
	"eligible_users" integer,
	"pairs_created" integer DEFAULT 0 NOT NULL,
	"pairs_rejected" integer DEFAULT 0 NOT NULL,
	"tier_counts" jsonb,
	CONSTRAINT "match_runs_slot_unique" UNIQUE("band","locale","mode","slot"),
	CONSTRAINT "match_runs_mode_band" CHECK ("match_runs"."mode" = 'friends' OR "match_runs"."band" = 'adult')
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"band" "band" NOT NULL,
	"locale" "locale" NOT NULL,
	"mode" "mode" NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"run_id" uuid,
	"tier" smallint NOT NULL,
	"score" double precision NOT NULL,
	"teaser" jsonb NOT NULL,
	"alias_a" text NOT NULL,
	"alias_b" text NOT NULL,
	"status" "match_status" DEFAULT 'pending_game' NOT NULL,
	"close_reason" "match_close_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"game_deadline_at" timestamp with time zone NOT NULL,
	"results_ready_at" timestamp with time zone,
	"chat_deadline_at" timestamp with time zone,
	"first_message_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "matches_pair_unique" UNIQUE("user_a_id","user_b_id"),
	CONSTRAINT "matches_user_order" CHECK ("matches"."user_a_id" < "matches"."user_b_id"),
	CONSTRAINT "matches_mode_band" CHECK ("matches"."mode" = 'friends' OR "matches"."band" = 'adult'),
	CONSTRAINT "matches_tier_range" CHECK ("matches"."tier" BETWEEN 1 AND 3),
	CONSTRAINT "matches_aliases_differ" CHECK ("matches"."alias_a" <> "matches"."alias_b"),
	CONSTRAINT "matches_closed_fields" CHECK (("matches"."status" IN ('expired', 'closed')) = ("matches"."close_reason" IS NOT NULL) AND ("matches"."status" IN ('expired', 'closed')) = ("matches"."closed_at" IS NOT NULL)),
	CONSTRAINT "matches_expired_reason" CHECK (("matches"."status" = 'expired') = coalesce("matches"."close_reason" = 'expired', false))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "outbox_kind" NOT NULL,
	"match_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_cancel_reason" CHECK (("outbox"."status" = 'cancelled') = ("outbox"."cancel_reason" IS NOT NULL)),
	CONSTRAINT "outbox_sent_at" CHECK (("outbox"."status" = 'sent') = ("outbox"."sent_at" IS NOT NULL)),
	CONSTRAINT "outbox_match_kind" CHECK ("outbox"."kind" <> 'match_created' OR "outbox"."match_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dating_age_min" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dating_age_max" smallint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "synthetic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocks" ADD CONSTRAINT "blocks_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_run_id_match_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."match_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocks_blocked_idx" ON "blocks" USING btree ("blocked_id");--> statement-breakpoint
CREATE INDEX "matches_user_b_idx" ON "matches" USING btree ("user_b_id");--> statement-breakpoint
CREATE INDEX "matches_open_a_idx" ON "matches" USING btree ("user_a_id") WHERE "matches"."status" IN ('pending_game', 'results_ready', 'active');--> statement-breakpoint
CREATE INDEX "matches_open_b_idx" ON "matches" USING btree ("user_b_id") WHERE "matches"."status" IN ('pending_game', 'results_ready', 'active');--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" USING btree ("next_attempt_at") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_user_pending_idx" ON "outbox" USING btree ("user_id") WHERE "outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "outbox_match_idx" ON "outbox" USING btree ("match_id");--> statement-breakpoint
-- Hand-written (not generated): Q12 backfill. Users already in dating mode get the default partner
-- age range (own age ±5, never below 18) before the CHECK below starts requiring one.
UPDATE "users" SET
  "dating_age_min" = greatest(18, vc_age_years("birth_date", vc_today()) - 5),
  "dating_age_max" = least(120, vc_age_years("birth_date", vc_today()) + 5)
WHERE "mode" = 'dating';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_dating_age_range" CHECK (CASE WHEN coalesce("users"."mode" = 'dating', false)
        THEN "users"."dating_age_min" IS NOT NULL AND "users"."dating_age_max" IS NOT NULL AND "users"."dating_age_min" >= 18 AND "users"."dating_age_min" <= "users"."dating_age_max" AND "users"."dating_age_max" <= 120
        ELSE "users"."dating_age_min" IS NULL AND "users"."dating_age_max" IS NULL END);--> statement-breakpoint
-- Hand-written (not generated): admin_set_birth_date() from migration 0003, now also clearing the
-- dating age range (Q12) when the corrected band is not adult; the CHECK above would otherwise
-- reject the correction. Ownership and privileges are unchanged (owner only).
CREATE OR REPLACE FUNCTION admin_set_birth_date(p_user_id uuid, p_new_date date, p_admin_tg_id bigint, p_reason text)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    v_old users%ROWTYPE;
    v_today date := vc_today();
    v_band band;
  BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
      RAISE EXCEPTION 'admin_set_birth_date: a reason is required' USING ERRCODE = 'SS002';
    END IF;
    IF p_admin_tg_id IS NULL OR p_admin_tg_id <= 0 THEN
      RAISE EXCEPTION 'admin_set_birth_date: the admin telegram id is required' USING ERRCODE = 'SS002';
    END IF;
    IF p_new_date IS NULL OR p_new_date > v_today OR vc_age_years(p_new_date, v_today) > 120 THEN
      RAISE EXCEPTION 'admin_set_birth_date: implausible birth date' USING ERRCODE = 'SS002';
    END IF;

    SELECT * INTO v_old FROM users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'admin_set_birth_date: user not found' USING ERRCODE = 'SS003';
    END IF;
    v_band := vc_band(p_new_date, v_today);

    PERFORM set_config('samesync.birth_date_override', 'on', true);
    UPDATE users SET
      birth_date = p_new_date,
      username = CASE WHEN v_band = 'adult' THEN username END,
      mode = CASE WHEN v_band = 'adult' THEN mode WHEN v_band = 'u18' THEN 'friends'::mode END,
      gender = CASE WHEN v_band = 'adult' THEN gender END,
      seeking = CASE WHEN v_band = 'adult' THEN seeking END,
      dating_age_min = CASE WHEN v_band = 'adult' THEN dating_age_min END,
      dating_age_max = CASE WHEN v_band = 'adult' THEN dating_age_max END,
      timezone = CASE WHEN v_band IS NOT NULL THEN timezone END,
      onboarded_at = CASE WHEN v_band IS NOT NULL THEN onboarded_at END,
      status = CASE
        WHEN v_band IS NULL THEN 'ineligible'::user_status
        WHEN status = 'ineligible' THEN 'onboarding'::user_status
        ELSE status
      END
    WHERE id = p_user_id;
    PERFORM set_config('samesync.birth_date_override', 'off', true);

    IF v_band IS NULL THEN
      DELETE FROM answers WHERE user_id = p_user_id;
      DELETE FROM user_interests WHERE user_id = p_user_id;
    END IF;

    INSERT INTO admin_actions (admin_telegram_id, action, target_user_id, before, after, reason)
    SELECT p_admin_tg_id, 'set_birth_date', p_user_id,
      jsonb_build_object('birth_date', v_old.birth_date, 'age_band', v_old.age_band, 'status', v_old.status),
      jsonb_build_object('birth_date', u.birth_date, 'age_band', u.age_band, 'status', u.status),
      p_reason
    FROM users u WHERE u.id = p_user_id;
  END
  $$;
