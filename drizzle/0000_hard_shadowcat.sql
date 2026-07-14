CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"asset_kind" varchar(30) NOT NULL,
	"mime_type" varchar(120) NOT NULL,
	"original_object_key" text NOT NULL,
	"derivative_object_key" text,
	"processing_status" varchar(30) DEFAULT 'pending' NOT NULL,
	"processing_error" text,
	"caption" text,
	"captured_at_text" text,
	"sequence_order" integer NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_kind_sequence_check" CHECK (("assets"."asset_kind" = 'image' AND "assets"."sequence_order" BETWEEN 0 AND 6) OR ("assets"."asset_kind" IN ('text', 'source_audio', 'creator_narration') AND "assets"."sequence_order" = 0)),
	CONSTRAINT "assets_pending_expiry_check" CHECK ("assets"."processing_status" <> 'pending' OR "assets"."reservation_expires_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"asset_id" uuid,
	"creator_answer_id" uuid,
	"type" varchar(40) NOT NULL,
	"claim" text NOT NULL,
	"original_claim" text NOT NULL,
	"source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_excerpt" text NOT NULL,
	"confidence" real,
	"verification_status" varchar(20) DEFAULT 'proposed' NOT NULL,
	"correction" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "film_scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"storyboard_id" uuid NOT NULL,
	"scene_type" varchar(30) NOT NULL,
	"title" text,
	"narration_text" text,
	"caption_text" text,
	"duration_seconds" real NOT NULL,
	"sequence_order" integer NOT NULL,
	"asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_narration_object_key" text,
	"motion_preset" varchar(40) NOT NULL,
	"transition_preset" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_answers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interview_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"question" text NOT NULL,
	"reason" text NOT NULL,
	"sequence_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"asset_id" uuid,
	"job_type" varchar(40) NOT NULL,
	"status" varchar(30) DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"processing_started_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"lease_token" uuid,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" varchar(160) NOT NULL,
	"creator_name" varchar(120) NOT NULL,
	"creator_relationship" varchar(120) NOT NULL,
	"gift_intention" text,
	"status" varchar(40) DEFAULT 'gathering' NOT NULL,
	"owner_token_hash" varchar(64) NOT NULL,
	"rendered_film_object_key" text,
	"rendered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storyboards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"theme" text NOT NULL,
	"time_range_text" text,
	"status" varchar(30) DEFAULT 'draft' NOT NULL,
	"dedication" text,
	"narration_source" varchar(20) DEFAULT 'openai' NOT NULL,
	"narrator_voice" varchar(80),
	"creator_narration_asset_id" uuid,
	"target_duration_seconds" integer DEFAULT 180 NOT NULL,
	"render_manifest" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"living_status" varchar(20) DEFAULT 'unspecified' NOT NULL,
	"consent_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"profile" jsonb NOT NULL,
	"evidence_item_ids" jsonb NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_creator_answer_id_interview_answers_id_fk" FOREIGN KEY ("creator_answer_id") REFERENCES "public"."interview_answers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_scenes" ADD CONSTRAINT "film_scenes_storyboard_id_storyboards_id_fk" FOREIGN KEY ("storyboard_id") REFERENCES "public"."storyboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_question_id_interview_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."interview_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_jobs" ADD CONSTRAINT "processing_jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storyboards" ADD CONSTRAINT "storyboards_creator_narration_asset_id_assets_id_fk" FOREIGN KEY ("creator_narration_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_profiles" ADD CONSTRAINT "voice_profiles_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_project_kind_sequence_unique" ON "assets" USING btree ("project_id","asset_kind","sequence_order") WHERE "assets"."processing_status" <> 'cleanup_pending';--> statement-breakpoint
CREATE UNIQUE INDEX "assets_original_object_key_unique" ON "assets" USING btree ("original_object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "storyboards_project_id_unique" ON "storyboards" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subjects_project_id_unique" ON "subjects" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "voice_profiles_project_id_unique" ON "voice_profiles" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_jobs_active_analysis_unique" ON "processing_jobs" USING btree ("project_id","job_type") WHERE "processing_jobs"."status" IN ('pending', 'processing');
