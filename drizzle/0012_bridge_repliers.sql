ALTER TABLE "bridge_rules" ADD COLUMN IF NOT EXISTS "allowed_senders" text DEFAULT '' NOT NULL;
