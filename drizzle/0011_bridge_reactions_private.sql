CREATE TABLE IF NOT EXISTS "bridge_contact_topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"peer_chat_id" text NOT NULL,
	"peer_name" text DEFAULT '' NOT NULL,
	"dst_chat_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "forward_reactions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_contact_topics_peer_uq" ON "bridge_contact_topics" USING btree ("rule_id","peer_chat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_contact_topics_topic_idx" ON "bridge_contact_topics" USING btree ("dst_chat_id","topic_id");
