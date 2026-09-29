CREATE TYPE "public"."document_type" AS ENUM('invoice');--> statement-breakpoint
CREATE TYPE "public"."factor_type" AS ENUM('password', 'pin', 'totp', 'passkey');--> statement-breakpoint
CREATE TYPE "public"."invoice_state" AS ENUM('submitted', 'issued', 'void', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('new', 'assigned', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."login_stage" AS ENUM('password', 'pin', 'unlock', 'step_up', 'recovery');--> statement-breakpoint
CREATE TYPE "public"."message_action" AS ENUM('issue', 'copy', 'recopy', 'requeue', 'open_chat');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('cash', 'upi', 'other');--> statement-breakpoint
CREATE TYPE "public"."record_source" AS ENUM('app', 'imported');--> statement-breakpoint
CREATE TYPE "public"."session_kind" AS ENUM('desktop', 'mobile');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."void_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "appliance_types" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"reminder_interval_months" smallint,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "appliance_types_interval_ck" CHECK ("appliance_types"."reminder_interval_months" is null or "appliance_types"."reminder_interval_months" between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"old_values" jsonb,
	"new_values" jsonb,
	"reason" text,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "auth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"factor_type" "factor_type" NOT NULL,
	"secret_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"name" text NOT NULL,
	"area_id" uuid,
	"reminders_opt_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_e164_unique" UNIQUE("phone_e164"),
	CONSTRAINT "customers_phone_e164_ck" CHECK ("customers"."phone_e164" ~ '^\+[1-9][0-9]{7,14}$')
);
--> statement-breakpoint
CREATE TABLE "invoice_counter" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"start_value" integer NOT NULL,
	"next_value" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_counter_single_row_ck" CHECK ("invoice_counter"."id" = 1),
	CONSTRAINT "invoice_counter_start_range_ck" CHECK ("invoice_counter"."start_value" between 10000 and 89999),
	CONSTRAINT "invoice_counter_next_ck" CHECK ("invoice_counter"."next_value" >= "invoice_counter"."start_value")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"state" "invoice_state" DEFAULT 'submitted' NOT NULL,
	"document_type" "document_type" DEFAULT 'invoice' NOT NULL,
	"invoice_number" integer,
	"idempotency_key" uuid NOT NULL,
	"invoice_date" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"total_paise" bigint NOT NULL,
	"spare_cost_paise" bigint DEFAULT 0 NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"template_version" smallint,
	"rendered_message" text,
	"submitted_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issued_by" uuid,
	"issued_at" timestamp with time zone,
	"copy_count" integer DEFAULT 0 NOT NULL,
	"last_copied_by" uuid,
	"last_copied_at" timestamp with time zone,
	"requeued_by" uuid,
	"requeued_at" timestamp with time zone,
	"rejected_reason" text,
	"rejected_by" uuid,
	"rejected_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"backdate_reason" text,
	"edited_flag" boolean DEFAULT false NOT NULL,
	"negative_margin_flag" boolean DEFAULT false NOT NULL,
	"self_issued_flag" boolean DEFAULT false NOT NULL,
	"warranty_expires_at" date GENERATED ALWAYS AS (invoice_date + 90) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_number_unique" UNIQUE("invoice_number"),
	CONSTRAINT "invoices_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "invoices_total_positive_ck" CHECK ("invoices"."total_paise" > 0),
	CONSTRAINT "invoices_spare_nonneg_ck" CHECK ("invoices"."spare_cost_paise" >= 0),
	CONSTRAINT "invoices_tax_nonneg_ck" CHECK ("invoices"."tax_paise" >= 0),
	CONSTRAINT "invoices_number_range_ck" CHECK ("invoices"."invoice_number" is null or "invoices"."invoice_number" >= 10000),
	CONSTRAINT "invoices_number_state_ck" CHECK (("invoices"."state" in ('issued', 'void')) = ("invoices"."invoice_number" is not null)),
	CONSTRAINT "invoices_issued_fields_ck" CHECK ("invoices"."state" not in ('issued', 'void') or ("invoices"."rendered_message" is not null and "invoices"."template_version" is not null and "invoices"."issued_by" is not null and "invoices"."issued_at" is not null)),
	CONSTRAINT "invoices_rejected_fields_ck" CHECK ("invoices"."state" <> 'rejected' or (length(trim(coalesce("invoices"."rejected_reason", ''))) > 0 and "invoices"."rejected_by" is not null and "invoices"."rejected_at" is not null)),
	CONSTRAINT "invoices_void_fields_ck" CHECK ("invoices"."state" <> 'void' or (length(trim(coalesce("invoices"."void_reason", ''))) > 0 and "invoices"."voided_by" is not null and "invoices"."voided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"appliance_type_key" text NOT NULL,
	"brand_id" uuid,
	"area_id" uuid,
	"service_description" text NOT NULL,
	"status" "job_status" DEFAULT 'new' NOT NULL,
	"assigned_to" uuid,
	"scheduled_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"source" "record_source" DEFAULT 'app' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_completed_at_ck" CHECK ("jobs"."status" <> 'completed' or "jobs"."completed_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"username_attempted" text NOT NULL,
	"user_id" uuid,
	"ip" text,
	"stage" "login_stage" NOT NULL,
	"success" boolean NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"action" "message_action" NOT NULL,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"collected_by_user_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_to_owner_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_positive_ck" CHECK ("payments"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_presets_label_unique" UNIQUE("label")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" "session_kind" NOT NULL,
	"device_label" text,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_pin_at" timestamp with time zone DEFAULT now() NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"pin_fail_count" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"role_key" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"must_change" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "void_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "void_request_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "void_requests_reason_ck" CHECK (length(trim("void_requests"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_credentials" ADD CONSTRAINT "auth_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_last_copied_by_users_id_fk" FOREIGN KEY ("last_copied_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_requeued_by_users_id_fk" FOREIGN KEY ("requeued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_rejected_by_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_appliance_type_key_appliance_types_key_fk" FOREIGN KEY ("appliance_type_key") REFERENCES "public"."appliance_types"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "login_attempts" ADD CONSTRAINT "login_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_log" ADD CONSTRAINT "message_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_user_id_users_id_fk" FOREIGN KEY ("collected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "void_requests" ADD CONSTRAINT "void_requests_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "void_requests" ADD CONSTRAINT "void_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "void_requests" ADD CONSTRAINT "void_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "areas_name_lower_uq" ON "areas" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_credentials_one_active_pw_pin_uq" ON "auth_credentials" USING btree ("user_id","factor_type") WHERE "auth_credentials"."revoked_at" is null and "auth_credentials"."factor_type" in ('password', 'pin');--> statement-breakpoint
CREATE UNIQUE INDEX "brands_name_lower_uq" ON "brands" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "invoices_state_submitted_idx" ON "invoices" USING btree ("state","submitted_at");--> statement-breakpoint
CREATE INDEX "invoices_submitted_by_idx" ON "invoices" USING btree ("submitted_by","submitted_at");--> statement-breakpoint
CREATE INDEX "invoices_job_idx" ON "invoices" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_customer_appliance_idx" ON "jobs" USING btree ("customer_id","appliance_type_key","completed_at");--> statement-breakpoint
CREATE INDEX "login_attempts_user_time_idx" ON "login_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "message_log_invoice_idx" ON "message_log" USING btree ("invoice_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_idx" ON "recovery_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_uq" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "void_requests_one_pending_uq" ON "void_requests" USING btree ("invoice_id") WHERE "void_requests"."status" = 'pending';