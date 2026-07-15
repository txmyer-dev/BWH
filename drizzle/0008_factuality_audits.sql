CREATE TABLE "factuality_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"storyboard_id" uuid NOT NULL,
	"provider_run_id" uuid NOT NULL,
	"storyboard_revision" integer NOT NULL,
	"evidence_hash" varchar(64) NOT NULL,
	"narration_hash" varchar(64) NOT NULL,
	"status" varchar(20) NOT NULL,
	"findings" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "factuality_audits_status_check" CHECK ("factuality_audits"."status" IN ('passed','blocked'))
);
--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "current_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "narration_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "narration_approval_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "narration_approval_evidence_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "narration_approval_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "audio_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "storyboards" ADD COLUMN "narration_track_selection" jsonb;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_storyboard_id_storyboards_id_fk" FOREIGN KEY ("storyboard_id") REFERENCES "public"."storyboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "factuality_audits_provider_run_unique" ON "factuality_audits" USING btree ("provider_run_id");--> statement-breakpoint
CREATE INDEX "factuality_audits_project_storyboard_idx" ON "factuality_audits" USING btree ("project_id","storyboard_id");