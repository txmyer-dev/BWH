ALTER TABLE "project_provider_budgets" DROP CONSTRAINT "project_provider_request_budgets_limit_check";--> statement-breakpoint
ALTER TABLE "project_provider_budgets" DROP CONSTRAINT "project_provider_budgets_limit_check";--> statement-breakpoint
ALTER TABLE "provider_artifacts" ADD COLUMN "cleanup_claim_token" uuid;--> statement-breakpoint
ALTER TABLE "provider_artifacts" ADD COLUMN "cleanup_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "consent_snapshot_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "data_categories" jsonb;--> statement-breakpoint
UPDATE "provider_runs" SET "consent_snapshot_hash" = "project_consents"."snapshot_hash", "data_categories" = "project_consents"."data_categories" FROM "project_consents" WHERE "provider_runs"."consent_id" = "project_consents"."id";--> statement-breakpoint
ALTER TABLE "provider_runs" ALTER COLUMN "consent_snapshot_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_runs" ALTER COLUMN "data_categories" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD COLUMN "usage_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_retry_of_run_id_provider_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."provider_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_runs_retry_of_run_idx" ON "provider_runs" USING btree ("retry_of_run_id");
