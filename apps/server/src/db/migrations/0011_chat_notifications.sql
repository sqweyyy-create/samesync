ALTER TYPE "public"."outbox_kind" ADD VALUE 'chat_reminder';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'chat_expired';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'chat_ended';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'reveal_request';--> statement-breakpoint
ALTER TYPE "public"."outbox_kind" ADD VALUE 'reveal_done';