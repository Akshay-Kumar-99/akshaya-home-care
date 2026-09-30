CREATE TYPE "public"."technician_mode" AS ENUM('invoice_only', 'invoice_and_work');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "service_description" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "complaint" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "visit_address" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "assigned_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "technician_mode" "technician_mode";--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_assigned_idx" ON "jobs" USING btree ("assigned_to","status","scheduled_at");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_completed_service_ck" CHECK ("jobs"."status" <> 'completed' or "jobs"."service_description" is not null);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_ck" CHECK ("jobs"."status" not in ('assigned', 'in_progress') or "jobs"."assigned_to" is not null);--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_cancelled_ck" CHECK ("jobs"."status" <> 'cancelled' or "jobs"."cancelled_at" is not null or "jobs"."assigned_to" is null);--> statement-breakpoint
-- Existing technicians become "Invoice only" before the rule is enforced.
UPDATE "users" SET "technician_mode" = 'invoice_only' WHERE "role_key" = 'technician';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_technician_mode_ck" CHECK (("users"."role_key" = 'technician') = ("users"."technician_mode" is not null));