CREATE TABLE "academic_nodes" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_type" text NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"parent_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"resource_id" integer,
	"outcome" text NOT NULL,
	"sanitized_error" text
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"drive_source_id" integer NOT NULL,
	"drive_file_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint,
	"modified_time" timestamp with time zone,
	"parent_folder_id" text,
	"folder_path" text,
	"web_view_link" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"folder_id" text NOT NULL,
	"credential_ref" text NOT NULL,
	"recursive_scan" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_error" text,
	CONSTRAINT "drive_sources_folder_id_unique" UNIQUE("folder_id")
);
--> statement-breakpoint
CREATE TABLE "registered_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"participant_id" text NOT NULL,
	"display_name" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registered_users_participant_id_unique" UNIQUE("participant_id")
);
--> statement-breakpoint
CREATE TABLE "resource_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"node_id" integer,
	"resource_id" integer,
	"alias" text NOT NULL,
	"alias_normalized" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_node_links" (
	"resource_id" integer NOT NULL,
	"node_id" integer NOT NULL,
	CONSTRAINT "resource_node_links_resource_id_node_id_pk" PRIMARY KEY("resource_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "resource_sources" (
	"resource_id" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_record_id" integer NOT NULL,
	"source_url" text,
	"is_preferred" boolean DEFAULT false NOT NULL,
	"delivery_eligible" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp with time zone,
	CONSTRAINT "resource_sources_resource_id_source_type_source_record_id_pk" PRIMARY KEY("resource_id","source_type","source_record_id")
);
--> statement-breakpoint
CREATE TABLE "resource_tags" (
	"resource_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "resource_tags_resource_id_tag_id_pk" PRIMARY KEY("resource_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"resource_type" text DEFAULT 'file' NOT NULL,
	"academic_node_id" integer,
	"classification_status" text DEFAULT 'uncategorized' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_kind_source_key_pk" PRIMARY KEY("kind","source_key")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "telegram_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"message_date" timestamp with time zone NOT NULL,
	"text_or_caption" text,
	"entities_json" jsonb,
	"hashtags" text[] DEFAULT '{}'::text[] NOT NULL,
	"media_type" text,
	"file_name" text,
	"mime_type" text,
	"file_size_bytes" bigint,
	"telegram_permalink" text,
	"edit_date" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sync_status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"participant_hash" text NOT NULL,
	"event" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"conversation_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"current_menu" text DEFAULT 'home' NOT NULL,
	"session_data_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"page_number" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_drive_source_id_drive_sources_id_fk" FOREIGN KEY ("drive_source_id") REFERENCES "public"."drive_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_aliases" ADD CONSTRAINT "resource_aliases_node_id_academic_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."academic_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_aliases" ADD CONSTRAINT "resource_aliases_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_node_links" ADD CONSTRAINT "resource_node_links_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_node_links" ADD CONSTRAINT "resource_node_links_node_id_academic_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."academic_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_sources" ADD CONSTRAINT "resource_sources_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_tags" ADD CONSTRAINT "resource_tags_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_tags" ADD CONSTRAINT "resource_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_academic_node_id_academic_nodes_id_fk" FOREIGN KEY ("academic_node_id") REFERENCES "public"."academic_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "academic_nodes_parent_idx" ON "academic_nodes" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_files_uq" ON "drive_files" USING btree ("drive_source_id","drive_file_id");--> statement-breakpoint
CREATE INDEX "resources_status_idx" ON "resources" USING btree ("classification_status");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_messages_uq" ON "telegram_messages" USING btree ("telegram_chat_id","telegram_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_uq" ON "user_sessions" USING btree ("provider","conversation_id","participant_id");