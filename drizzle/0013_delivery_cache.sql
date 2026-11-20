CREATE TABLE IF NOT EXISTS "delivery_cache" (
  "key" text PRIMARY KEY NOT NULL,
  "raw" text NOT NULL,
  "follow_up_text" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
