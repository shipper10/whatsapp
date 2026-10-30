CREATE TABLE "subscriptions" (
	"conversation_id" text PRIMARY KEY NOT NULL,
	"subscribed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_prefs" (
	"participant_id" text PRIMARY KEY NOT NULL,
	"lang" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
