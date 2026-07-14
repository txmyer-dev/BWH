CREATE TABLE "project_consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"purpose" varchar(20) NOT NULL,
	"document_version" varchar(80) NOT NULL,
	"providers" jsonb NOT NULL,
	"data_categories" jsonb NOT NULL,
	"permission_confirmed" boolean NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"snapshot_hash" varchar(64) NOT NULL,
	CONSTRAINT "project_consents_purpose_check" CHECK ("project_consents"."purpose" IN ('storage', 'processing')),
	CONSTRAINT "project_consents_permission_confirmed_check" CHECK ("project_consents"."permission_confirmed" = true)
);
--> statement-breakpoint
ALTER TABLE "project_consents" ADD CONSTRAINT "project_consents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;