CREATE TABLE IF NOT EXISTS "bridge_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"label" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"session" text,
	"identity" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "bridge_chats_uq";--> statement-breakpoint
ALTER TABLE "bridge_chats" ADD COLUMN IF NOT EXISTS "account_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "src_account_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "dst_account_id" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_chats_uq2" ON "bridge_chats" USING btree ("account_id","platform","chat_id","topic_id");
