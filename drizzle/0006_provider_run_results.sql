CREATE TABLE "provider_run_results" (
	"provider_run_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"structured_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_run_results" ADD CONSTRAINT "provider_run_results_provider_run_id_provider_runs_id_fk" FOREIGN KEY ("provider_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_run_results" ADD CONSTRAINT "provider_run_results_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_run_results_project_idx" ON "provider_run_results" USING btree ("project_id");