CREATE TABLE "drive_matches" (
	"drive_file_id" integer PRIMARY KEY NOT NULL,
	"telegram_message_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_matches" ADD CONSTRAINT "drive_matches_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_matches" ADD CONSTRAINT "drive_matches_telegram_message_id_telegram_messages_id_fk" FOREIGN KEY ("telegram_message_id") REFERENCES "public"."telegram_messages"("id") ON DELETE cascade ON UPDATE no action;