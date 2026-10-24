ALTER TABLE "academic_nodes" ADD COLUMN "node_key" text;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "resource_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "classification_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "source_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "academic_nodes" ADD CONSTRAINT "academic_nodes_node_key_unique" UNIQUE("node_key");--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_resource_key_unique" UNIQUE("resource_key");