CREATE TABLE "asset_transcripts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"provider_run_id" uuid NOT NULL,
	"text" text NOT NULL,
	"language" varchar(40),
	"confidence" real,
	"duration_ms" integer NOT NULL,
	"segments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_transcripts_duration_positive_check" CHECK ("asset_transcripts"."duration_ms" > 0),
	CONSTRAINT "asset_transcripts_confidence_check" CHECK ("asset_transcripts"."confidence" IS NULL OR ("asset_transcripts"."confidence" >= 0 AND "asset_transcripts"."confidence" <= 1))
);
--> statement-breakpoint
DROP INDEX "processing_jobs_active_analysis_unique";--> statement-breakpoint
ALTER TABLE "film_scenes" ADD COLUMN "authentic_clip" jsonb;--> statement-breakpoint
ALTER TABLE "asset_transcripts" ADD CONSTRAINT "asset_transcripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transcripts" ADD CONSTRAINT "asset_transcripts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_transcripts" ADD CONSTRAINT "asset_transcripts_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_transcripts_asset_unique" ON "asset_transcripts" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "asset_transcripts_provider_run_unique" ON "asset_transcripts" USING btree ("provider_run_id");--> statement-breakpoint
CREATE INDEX "asset_transcripts_project_idx" ON "asset_transcripts" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_active_transcription_asset_unique" ON "processing_jobs" USING btree ("project_id","asset_id","job_type") WHERE "processing_jobs"."job_type" = 'transcribe_asset' AND "processing_jobs"."status" IN ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_active_analysis_unique" ON "processing_jobs" USING btree ("project_id","job_type") WHERE "processing_jobs"."job_type" = 'analyze_collection' AND "processing_jobs"."status" IN ('pending', 'processing');