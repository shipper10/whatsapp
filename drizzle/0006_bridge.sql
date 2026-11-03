CREATE TABLE IF NOT EXISTS "bridge_chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"chat_id" text NOT NULL,
	"topic_id" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"parent_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bridge_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" text NOT NULL,
	"src_platform" text NOT NULL,
	"src_chat_id" text NOT NULL,
	"src_message_id" text NOT NULL,
	"rule_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bridge_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"src_platform" text NOT NULL,
	"src_chat_id" text NOT NULL,
	"src_topic_id" text DEFAULT '' NOT NULL,
	"dst_platform" text NOT NULL,
	"dst_chat_id" text NOT NULL,
	"dst_topic_id" text DEFAULT '' NOT NULL,
	"types" text[] NOT NULL,
	"show_sender" boolean DEFAULT true NOT NULL,
	"show_phone" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_chats_uq" ON "bridge_chats" USING btree ("platform","chat_id","topic_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_links_dst_uq" ON "bridge_links" USING btree ("platform","chat_id","message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_links_src_idx" ON "bridge_links" USING btree ("src_platform","src_chat_id","src_message_id");