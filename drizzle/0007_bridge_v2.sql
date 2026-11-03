ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "sender_mode" text DEFAULT 'saved' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "custom_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "forward_own" boolean DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE "bridge_rules" SET "sender_mode" = 'none' WHERE "show_sender" = false;
