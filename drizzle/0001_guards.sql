-- Integrity guards that must hold even if application code has a bug.
-- 1. No hard deletes (or TRUNCATE) on business and audit tables.
-- 2. audit_log and message_log are append-only.
-- 3. invoice_counter: start_value is immutable, next_value only ever moves by +1.
-- 4. invoices: legal state transitions only; issued content is frozen; terminal states are final;
--    invoice_date is server-set and changes only through the Master backdate path.
-- 5. Derived views: warranty callbacks and service-due reminders.

CREATE OR REPLACE FUNCTION ahc_forbid_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'hard deletes are not allowed on %', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles', 'users', 'auth_credentials', 'recovery_codes', 'areas', 'brands', 'appliance_types',
    'service_presets', 'customers', 'jobs', 'invoices', 'void_requests', 'payments', 'message_log',
    'settings', 'audit_log', 'invoice_counter'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION ahc_forbid_delete()',
      t || '_no_delete', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION ahc_forbid_delete()',
      t || '_no_truncate', t);
  END LOOP;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION ahc_append_only();
--> statement-breakpoint

CREATE TRIGGER message_log_append_only BEFORE UPDATE ON message_log
  FOR EACH ROW EXECUTE FUNCTION ahc_append_only();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_invoice_counter_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.start_value <> OLD.start_value OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invoice_counter start is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.next_value <> OLD.next_value + 1 THEN
    RAISE EXCEPTION 'invoice_counter may only advance by exactly 1' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER invoice_counter_guard BEFORE UPDATE ON invoice_counter
  FOR EACH ROW EXECUTE FUNCTION ahc_invoice_counter_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_ist_today() RETURNS date
LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date $$;
--> statement-breakpoint

-- Backdating is allowed only when the application sets ahc.allow_backdate = 'on' for the
-- current transaction (Master-only path, reason required, audited by the application).
CREATE OR REPLACE FUNCTION ahc_backdate_allowed() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('ahc.allow_backdate', true), '') = 'on' $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_invoices_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'submitted' OR NEW.invoice_number IS NOT NULL OR NEW.rendered_message IS NOT NULL
     OR NEW.issued_by IS NOT NULL OR NEW.issued_at IS NOT NULL THEN
    RAISE EXCEPTION 'invoices must be inserted in state submitted without a number'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.invoice_date > ahc_ist_today() THEN
    RAISE EXCEPTION 'invoice_date cannot be in the future' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.invoice_date <> ahc_ist_today()
     AND (NOT ahc_backdate_allowed() OR coalesce(trim(NEW.backdate_reason), '') = '') THEN
    RAISE EXCEPTION 'invoice_date is set by the server; backdating needs the Master path and a reason'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER invoices_insert_guard BEFORE INSERT ON invoices
  FOR EACH ROW EXECUTE FUNCTION ahc_invoices_insert_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ahc_invoices_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Terminal states are final.
  IF OLD.state IN ('void', 'rejected') THEN
    RAISE EXCEPTION 'invoice in state % cannot be modified', OLD.state USING ERRCODE = 'check_violation';
  END IF;

  -- Identity columns never change.
  IF NEW.id <> OLD.id OR NEW.job_id <> OLD.job_id OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.submitted_by <> OLD.submitted_by OR NEW.submitted_at <> OLD.submitted_at
     OR NEW.document_type <> OLD.document_type OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'invoice identity columns are immutable' USING ERRCODE = 'check_violation';
  END IF;

  -- Legal transitions: submitted -> issued | rejected, issued -> void.
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'submitted' AND NEW.state IN ('issued', 'rejected'))
    OR (OLD.state = 'issued' AND NEW.state = 'void')
  ) THEN
    RAISE EXCEPTION 'illegal invoice state transition % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  -- Once issued, the financial content and the customer message are frozen.
  IF OLD.state = 'issued' AND (
       NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
    OR NEW.rendered_message IS DISTINCT FROM OLD.rendered_message
    OR NEW.template_version IS DISTINCT FROM OLD.template_version
    OR NEW.invoice_date <> OLD.invoice_date
    OR NEW.total_paise <> OLD.total_paise
    OR NEW.spare_cost_paise <> OLD.spare_cost_paise
    OR NEW.tax_paise <> OLD.tax_paise
    OR NEW.issued_by IS DISTINCT FROM OLD.issued_by
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.self_issued_flag <> OLD.self_issued_flag
    OR NEW.negative_margin_flag <> OLD.negative_margin_flag
    OR NEW.edited_flag <> OLD.edited_flag
    OR NEW.backdate_reason IS DISTINCT FROM OLD.backdate_reason
  ) THEN
    RAISE EXCEPTION 'issued invoices are immutable; void and re-enter to correct'
      USING ERRCODE = 'check_violation';
  END IF;

  -- invoice_date moves only backwards, only while submitted, only via the Master backdate path.
  IF OLD.state = 'submitted' AND NEW.invoice_date <> OLD.invoice_date THEN
    IF NOT ahc_backdate_allowed() OR coalesce(trim(NEW.backdate_reason), '') = ''
       OR NEW.invoice_date > OLD.invoice_date THEN
      RAISE EXCEPTION 'invoice_date can only be backdated by the Master with a reason'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER invoices_update_guard BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION ahc_invoices_update_guard();
--> statement-breakpoint

-- A completed job is a warranty callback when the same customer had a completed job on the
-- same appliance type in the preceding 90 days.
CREATE VIEW warranty_callbacks_v AS
SELECT
  j.id AS job_id,
  j.customer_id,
  j.appliance_type_key,
  j.completed_at,
  prior.id AS prior_job_id,
  prior.completed_at AS prior_completed_at
FROM jobs j
JOIN LATERAL (
  SELECT p.id, p.completed_at
  FROM jobs p
  WHERE p.customer_id = j.customer_id
    AND p.appliance_type_key = j.appliance_type_key
    AND p.status = 'completed'
    AND p.id <> j.id
    AND p.completed_at < j.completed_at
    AND p.completed_at >= j.completed_at - interval '90 days'
  ORDER BY p.completed_at DESC
  LIMIT 1
) prior ON true
WHERE j.status = 'completed';
--> statement-breakpoint

-- Service-due reminders, derived with no cron: the latest completed job per customer and
-- appliance type, due after the appliance type's reminder interval. Opted-out customers excluded.
CREATE VIEW service_due_v AS
SELECT DISTINCT ON (j.customer_id, j.appliance_type_key)
  j.customer_id,
  j.appliance_type_key,
  j.id AS last_job_id,
  j.completed_at AS last_completed_at,
  ((j.completed_at AT TIME ZONE 'Asia/Kolkata')::date
    + make_interval(months => apt.reminder_interval_months))::date AS due_date
FROM jobs j
JOIN appliance_types apt
  ON apt.key = j.appliance_type_key AND apt.active AND apt.reminder_interval_months IS NOT NULL
JOIN customers c
  ON c.id = j.customer_id AND NOT c.reminders_opt_out
WHERE j.status = 'completed'
ORDER BY j.customer_id, j.appliance_type_key, j.completed_at DESC;
