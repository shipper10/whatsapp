CREATE TABLE IF NOT EXISTS "bridge_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"msg_type" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "log_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_logs_rule_idx" ON "bridge_logs" USING btree ("rule_id","id");
