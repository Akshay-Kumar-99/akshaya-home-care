-- Defence in depth for technician requests.
--
-- The app connects as the Neon owner role, which has BYPASSRLS. For technician requests the app
-- runs `SET LOCAL ROLE ahc_technician_ctx` inside the request transaction
-- (src/server/db/actor-context.ts). This restricted role:
--   * sees and creates only its own jobs, invoices and payments (row-level security);
--   * cannot read invoices.rendered_message (column privileges): the customer message and the
--     WhatsApp flow are office-only;
--   * cannot touch invoice_counter, message_log, settings, sessions or credentials at all;
--   * can append audit rows only in its own name.
-- Admin and master requests run as the owner role and are governed by the RBAC policy module.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ahc_technician_ctx') THEN
    CREATE ROLE ahc_technician_ctx NOLOGIN NOBYPASSRLS NOINHERIT;
  END IF;
END;
$$;
--> statement-breakpoint

-- Let the app's login role switch into it (PG16+: SET option), without inheriting its rights.
GRANT ahc_technician_ctx TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_ctx_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('ahc.user_id', true), '')::uuid $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO ahc_technician_ctx;
--> statement-breakpoint

-- Reference data for the job form (typeaheads, chips).
GRANT SELECT ON appliance_types, areas, brands, service_presets TO ahc_technician_ctx;
--> statement-breakpoint
GRANT SELECT (id, display_name, role_key) ON users TO ahc_technician_ctx;
--> statement-breakpoint

-- Customers: phone lookup auto-fills name and area (spec); submissions upsert the customer.
GRANT SELECT ON customers TO ahc_technician_ctx;
--> statement-breakpoint
GRANT INSERT (phone_e164, name, area_id) ON customers TO ahc_technician_ctx;
--> statement-breakpoint
GRANT UPDATE (name, area_id, updated_at) ON customers TO ahc_technician_ctx;
--> statement-breakpoint

-- Jobs: own rows only.
GRANT SELECT ON jobs TO ahc_technician_ctx;
--> statement-breakpoint
GRANT INSERT (customer_id, appliance_type_key, brand_id, area_id, service_description, status,
              completed_at, source, created_by) ON jobs TO ahc_technician_ctx;
--> statement-breakpoint
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY jobs_technician_select ON jobs FOR SELECT TO ahc_technician_ctx
  USING (created_by = ahc_ctx_user_id());
--> statement-breakpoint
CREATE POLICY jobs_technician_insert ON jobs FOR INSERT TO ahc_technician_ctx
  WITH CHECK (created_by = ahc_ctx_user_id() AND source = 'app');
--> statement-breakpoint

-- Invoices: own rows only, every column EXCEPT rendered_message.
GRANT SELECT (id, job_id, state, document_type, invoice_number, idempotency_key, invoice_date,
              total_paise, spare_cost_paise, tax_paise, template_version, submitted_by, submitted_at,
              issued_by, issued_at, copy_count, last_copied_by, last_copied_at, requeued_by,
              requeued_at, rejected_reason, rejected_by, rejected_at, void_reason, voided_by,
              voided_at, backdate_reason, edited_flag, negative_margin_flag, self_issued_flag,
              warranty_expires_at, created_at, updated_at)
  ON invoices TO ahc_technician_ctx;
--> statement-breakpoint
GRANT INSERT (job_id, idempotency_key, total_paise, spare_cost_paise, negative_margin_flag, submitted_by)
  ON invoices TO ahc_technician_ctx;
--> statement-breakpoint
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invoices_technician_select ON invoices FOR SELECT TO ahc_technician_ctx
  USING (submitted_by = ahc_ctx_user_id());
--> statement-breakpoint
CREATE POLICY invoices_technician_insert ON invoices FOR INSERT TO ahc_technician_ctx
  WITH CHECK (submitted_by = ahc_ctx_user_id());
--> statement-breakpoint

-- Payments recorded at submission time, own rows only.
GRANT SELECT ON payments TO ahc_technician_ctx;
--> statement-breakpoint
GRANT INSERT (invoice_id, mode, amount_paise, collected_by_user_id) ON payments TO ahc_technician_ctx;
--> statement-breakpoint
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payments_technician_select ON payments FOR SELECT TO ahc_technician_ctx
  USING (collected_by_user_id = ahc_ctx_user_id());
--> statement-breakpoint
CREATE POLICY payments_technician_insert ON payments FOR INSERT TO ahc_technician_ctx
  WITH CHECK (collected_by_user_id = ahc_ctx_user_id());
--> statement-breakpoint

-- Audit: append-only, in their own name, no reading.
GRANT INSERT (actor_id, action, entity_type, entity_id, old_values, new_values, reason, ip)
  ON audit_log TO ahc_technician_ctx;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE audit_log_id_seq TO ahc_technician_ctx;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_log_technician_insert ON audit_log FOR INSERT TO ahc_technician_ctx
  WITH CHECK (actor_id = ahc_ctx_user_id());
