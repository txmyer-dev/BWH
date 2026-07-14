CREATE TABLE "project_provider_budgets" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"limit_micros" bigint NOT NULL,
	"reserved_micros" bigint DEFAULT 0 NOT NULL,
	"settled_micros" bigint DEFAULT 0 NOT NULL,
	"request_limit" integer NOT NULL,
	"reserved_requests" integer DEFAULT 0 NOT NULL,
	"settled_requests" integer DEFAULT 0 NOT NULL,
	"pricing_version" varchar(40) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_provider_budgets_nonnegative_check" CHECK ("project_provider_budgets"."limit_micros" >= 0 AND "project_provider_budgets"."reserved_micros" >= 0 AND "project_provider_budgets"."settled_micros" >= 0),
	CONSTRAINT "project_provider_request_budgets_nonnegative_check" CHECK ("project_provider_budgets"."request_limit" >= 0 AND "project_provider_budgets"."reserved_requests" >= 0 AND "project_provider_budgets"."settled_requests" >= 0),
	CONSTRAINT "project_provider_request_budgets_limit_check" CHECK ("project_provider_budgets"."reserved_requests" + "project_provider_budgets"."settled_requests" <= "project_provider_budgets"."request_limit"),
	CONSTRAINT "project_provider_budgets_limit_check" CHECK ("project_provider_budgets"."reserved_micros" + "project_provider_budgets"."settled_micros" <= "project_provider_budgets"."limit_micros")
);
--> statement-breakpoint
CREATE TABLE "provider_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_run_id" uuid,
	"provider" varchar(80) NOT NULL,
	"provider_artifact_id" text NOT NULL,
	"status" varchar(30) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cleanup_attempts" integer DEFAULT 0 NOT NULL,
	"last_cleanup_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_artifacts_status_check" CHECK ("provider_artifacts"."status" IN ('active','cleanup_pending','deletion_pending','cleanup_processing','deletion_processing','deleted','expired_confirmed'))
);
--> statement-breakpoint
CREATE TABLE "provider_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"consent_id" uuid NOT NULL,
	"provider" varchar(80) NOT NULL,
	"model" varchar(120) NOT NULL,
	"operation" varchar(40) NOT NULL,
	"input_fingerprint" varchar(64) NOT NULL,
	"status" varchar(30) NOT NULL,
	"estimated_cost_micros" bigint NOT NULL,
	"reserved_cost_micros" bigint NOT NULL,
	"settled_cost_micros" bigint,
	"pricing_version" varchar(40) NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"cache_hit_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"dispatch_deadline_at" timestamp with time zone,
	"provider_idempotency_key" varchar(120) NOT NULL,
	"retry_of_run_id" uuid,
	"active_result" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_runs_status_check" CHECK ("provider_runs"."status" IN ('reserved','processing','dispatching','completed','failed','ambiguous','superseded_ambiguous','late_completed')),
	CONSTRAINT "provider_runs_cost_nonnegative_check" CHECK ("provider_runs"."estimated_cost_micros" >= 0 AND "provider_runs"."reserved_cost_micros" >= 0 AND ("provider_runs"."settled_cost_micros" IS NULL OR "provider_runs"."settled_cost_micros" >= 0))
);
--> statement-breakpoint
ALTER TABLE "project_provider_budgets" ADD CONSTRAINT "project_provider_budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_runs" ADD CONSTRAINT "provider_runs_consent_id_project_consents_id_fk" FOREIGN KEY ("consent_id") REFERENCES "public"."project_consents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_artifacts_provider_identifier_unique" ON "provider_artifacts" USING btree ("provider","provider_artifact_id");--> statement-breakpoint
CREATE INDEX "provider_artifacts_cleanup_due_idx" ON "provider_artifacts" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_runs_active_success_fingerprint_unique" ON "provider_runs" USING btree ("project_id","provider","model","operation","input_fingerprint") WHERE "provider_runs"."status" IN ('reserved','processing','dispatching','completed','ambiguous') AND "provider_runs"."active_result" = true;--> statement-breakpoint
CREATE INDEX "provider_runs_project_created_idx" ON "provider_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_runs_dispatch_deadline_idx" ON "provider_runs" USING btree ("dispatch_deadline_at") WHERE "provider_runs"."status" = 'dispatching';
