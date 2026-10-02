CREATE TYPE "public"."locale" AS ENUM('ru', 'en');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('onboarding', 'active', 'waitlisted', 'ineligible', 'frozen', 'deleted');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"public_id" text NOT NULL,
	"locale" "locale" NOT NULL,
	"status" "user_status" DEFAULT 'onboarding' NOT NULL,
	"last_active_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id"),
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "users_telegram_id_positive" CHECK ("users"."telegram_id" > 0),
	CONSTRAINT "users_public_id_format" CHECK ("users"."public_id" ~ '^[0-9A-HJKMNP-TV-Z]{10}$')
);
