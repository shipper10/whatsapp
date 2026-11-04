CREATE TABLE IF NOT EXISTS "bridge_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"rule_id" integer NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bridge_jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "forward_edits" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "forward_deletes" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bridge_jobs_due_idx" ON "bridge_jobs" USING btree ("status","next_attempt_at");