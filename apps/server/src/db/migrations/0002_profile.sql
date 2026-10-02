CREATE TYPE "public"."answer_value" AS ENUM('agree', 'disagree', 'skip');--> statement-breakpoint
CREATE TYPE "public"."band" AS ENUM('u18', 'adult');--> statement-breakpoint
CREATE TYPE "public"."interest_domain" AS ENUM('music', 'games', 'shows', 'movies', 'books', 'memes');--> statement-breakpoint
CREATE TYPE "public"."mode" AS ENUM('friends', 'dating');--> statement-breakpoint
CREATE TYPE "public"."popularity" AS ENUM('mainstream', 'known', 'niche');--> statement-breakpoint
CREATE TABLE "content_releases" (
	"version" text PRIMARY KEY NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dating_options" (
	"id" text PRIMARY KEY NOT NULL,
	"revision" integer NOT NULL,
	"added_in" text NOT NULL,
	"retired_in" text
);
--> statement-breakpoint
CREATE TABLE "interest_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" "interest_domain" NOT NULL,
	"audiences" "band"[] NOT NULL,
	"locales" "locale"[] NOT NULL,
	"revision" integer NOT NULL,
	"added_in" text NOT NULL,
	"retired_in" text
);
--> statement-breakpoint
CREATE TABLE "interest_items" (
	"id" text PRIMARY KEY NOT NULL,
	"category_id" text NOT NULL,
	"popularity_prior" "popularity" NOT NULL,
	"audiences" "band"[] NOT NULL,
	"locales" "locale"[] NOT NULL,
	"revision" integer NOT NULL,
	"added_in" text NOT NULL,
	"retired_in" text
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"audiences" "band"[] NOT NULL,
	"modes" "mode"[] NOT NULL,
	"locales" "locale"[] NOT NULL,
	"prior_agree" real NOT NULL,
	"revision" integer NOT NULL,
	"added_in" text NOT NULL,
	"retired_in" text,
	CONSTRAINT "questions_prior_agree_range" CHECK ("questions"."prior_agree" > 0 AND "questions"."prior_agree" < 1)
);
--> statement-breakpoint
CREATE TABLE "answers" (
	"user_id" uuid NOT NULL,
	"question_id" text NOT NULL,
	"value" "answer_value" NOT NULL,
	"content_release" text NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	CONSTRAINT "answers_user_id_question_id_pk" PRIMARY KEY("user_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "user_interests" (
	"user_id" uuid NOT NULL,
	"item_id" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_interests_user_id_item_id_pk" PRIMARY KEY("user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admin_telegram_id" bigint NOT NULL,
	"action" text NOT NULL,
	"target_user_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_actions_reason_present" CHECK (length(btrim("admin_actions"."reason")) > 0),
	CONSTRAINT "admin_actions_admin_positive" CHECK ("admin_actions"."admin_telegram_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_band" "band";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mode" "mode";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "seeking" text[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "bot_reachable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interest_items" ADD CONSTRAINT "interest_items_category_id_interest_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."interest_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_content_release_content_releases_version_fk" FOREIGN KEY ("content_release") REFERENCES "public"."content_releases"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_item_id_interest_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."interest_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answers_question_value_idx" ON "answers" USING btree ("question_id","value");--> statement-breakpoint
CREATE INDEX "user_interests_item_idx" ON "user_interests" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_gender_dating_options_id_fk" FOREIGN KEY ("gender") REFERENCES "public"."dating_options"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_pool_idx" ON "users" USING btree ("age_band","locale","mode","status");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_mode_band" CHECK ("users"."mode" IS NULL OR "users"."mode" = 'friends' OR coalesce("users"."age_band" = 'adult', false));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_adult" CHECK ("users"."username" IS NULL OR coalesce("users"."age_band" = 'adult', false));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_mode_needs_band" CHECK ("users"."mode" IS NULL OR "users"."age_band" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_band_needs_birth_date" CHECK ("users"."age_band" IS NULL OR "users"."birth_date" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_dating_fields" CHECK (coalesce("users"."mode" = 'dating', false) = ("users"."gender" IS NOT NULL AND "users"."seeking" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_seeking_not_empty" CHECK ("users"."seeking" IS NULL OR cardinality("users"."seeking") >= 1);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_ineligible_minimal" CHECK ("users"."status" <> 'ineligible' OR ("users"."mode" IS NULL AND "users"."gender" IS NULL AND "users"."seeking" IS NULL AND "users"."username" IS NULL AND "users"."timezone" IS NULL AND "users"."onboarded_at" IS NULL));