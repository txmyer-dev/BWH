CREATE TABLE "narration_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"storyboard_id" uuid NOT NULL,
	"provider_run_id" uuid NOT NULL,
	"provider" varchar(30) NOT NULL,
	"model" varchar(120) NOT NULL,
	"voice" varchar(120) NOT NULL,
	"source_text_hash" varchar(64) NOT NULL,
	"audit_id" uuid NOT NULL,
	"narration_hash" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "narration_samples_provider_check" CHECK ("narration_samples"."provider" IN ('deepgram','azure')),
	CONSTRAINT "narration_samples_duration_check" CHECK ("narration_samples"."duration_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "narration_tracks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"storyboard_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"provider_run_id" uuid NOT NULL,
	"provider" varchar(30) NOT NULL,
	"model" varchar(120) NOT NULL,
	"voice" varchar(120) NOT NULL,
	"source_text_hash" varchar(64) NOT NULL,
	"audit_id" uuid NOT NULL,
	"narration_hash" varchar(64) NOT NULL,
	"object_key" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "narration_tracks_provider_check" CHECK ("narration_tracks"."provider" IN ('deepgram','azure')),
	CONSTRAINT "narration_tracks_duration_check" CHECK ("narration_tracks"."duration_ms" > 0)
);
--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "creator_transcript_audit_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "creator_transcript_approval_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD COLUMN "audit_scope" varchar(30) DEFAULT 'narration_text' NOT NULL;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD COLUMN "creator_narration_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD COLUMN "creator_transcript_id" uuid;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_scope_check" CHECK ("factuality_audits"."audit_scope" IN ('narration_text','creator_audio'));--> statement-breakpoint
ALTER TABLE "storyboards" ALTER COLUMN "narration_source" SET DEFAULT 'deepgram';--> statement-breakpoint
UPDATE "storyboards" AS s
SET "narration_source" = 'deepgram', "updated_at" = now()
WHERE s."narration_source" = 'openai'
  AND s."audio_approved_at" IS NULL
  AND s."narration_track_selection" IS NULL
  AND s."creator_narration_asset_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "film_scenes" f WHERE f."storyboard_id" = s."id" AND f."generated_narration_object_key" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "narration_samples" ADD CONSTRAINT "narration_samples_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_samples" ADD CONSTRAINT "narration_samples_storyboard_id_storyboards_id_fk" FOREIGN KEY ("storyboard_id") REFERENCES "public"."storyboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_samples" ADD CONSTRAINT "narration_samples_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_samples" ADD CONSTRAINT "narration_samples_audit_id_factuality_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."factuality_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_tracks" ADD CONSTRAINT "narration_tracks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_tracks" ADD CONSTRAINT "narration_tracks_storyboard_id_storyboards_id_fk" FOREIGN KEY ("storyboard_id") REFERENCES "public"."storyboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_tracks" ADD CONSTRAINT "narration_tracks_scene_id_film_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."film_scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_tracks" ADD CONSTRAINT "narration_tracks_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_tracks" ADD CONSTRAINT "narration_tracks_audit_id_factuality_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."factuality_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "narration_samples_provider_run_unique" ON "narration_samples" USING btree ("provider_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "narration_samples_object_key_unique" ON "narration_samples" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "narration_samples_project_idx" ON "narration_samples" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "narration_tracks_provider_run_unique" ON "narration_tracks" USING btree ("provider_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "narration_tracks_object_key_unique" ON "narration_tracks" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "narration_tracks_reuse_unique" ON "narration_tracks" USING btree ("project_id","scene_id","provider","model","voice","source_text_hash");--> statement-breakpoint
CREATE INDEX "narration_tracks_project_storyboard_idx" ON "narration_tracks" USING btree ("project_id","storyboard_id");--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_creator_narration_asset_id_assets_id_fk" FOREIGN KEY ("creator_narration_asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "factuality_audits" ADD CONSTRAINT "factuality_audits_creator_transcript_id_asset_transcripts_id_fk" FOREIGN KEY ("creator_transcript_id") REFERENCES "public"."asset_transcripts"("id") ON DELETE cascade ON UPDATE no action;
