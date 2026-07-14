ALTER TABLE "assets" ADD COLUMN "asset_kind" varchar(30);--> statement-breakpoint
UPDATE "assets"
SET "asset_kind" = CASE
	WHEN "metadata"->>'kind' = 'source-audio' THEN 'source_audio'
	WHEN "metadata"->>'kind' = 'creator-narration' THEN 'creator_narration'
	WHEN "metadata"->>'kind' IN ('image', 'text', 'source_audio', 'creator_narration') THEN "metadata"->>'kind'
	WHEN "type" = 'audio' THEN 'source_audio'
	ELSE "type"
END;--> statement-breakpoint
UPDATE "assets" SET "sequence_order" = 0 WHERE "asset_kind" <> 'image';--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "asset_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "reservation_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_project_kind_sequence_unique" ON "assets" USING btree ("project_id","asset_kind","sequence_order");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_original_object_key_unique" ON "assets" USING btree ("original_object_key");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_kind_sequence_check" CHECK (("assets"."asset_kind" = 'image' AND "assets"."sequence_order" BETWEEN 0 AND 6) OR ("assets"."asset_kind" IN ('text', 'source_audio', 'creator_narration') AND "assets"."sequence_order" = 0));
