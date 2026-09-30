-- Work allocation: row-level security for technicians (ahc_technician_ctx, see 0003_rls.sql).
-- A technician may see jobs they created OR that are assigned to them, may update only the
-- progress/completion columns of jobs assigned to them, and may raise an invoice only on a job
-- they created or that is assigned to them.

DROP POLICY IF EXISTS jobs_technician_select ON jobs;
--> statement-breakpoint
CREATE POLICY jobs_technician_select ON jobs FOR SELECT TO ahc_technician_ctx
  USING (created_by = ahc_ctx_user_id() OR assigned_to = ahc_ctx_user_id());
--> statement-breakpoint

GRANT UPDATE (status, started_at, completed_at, service_description, brand_id, updated_at)
  ON jobs TO ahc_technician_ctx;
--> statement-breakpoint
CREATE POLICY jobs_technician_update ON jobs FOR UPDATE TO ahc_technician_ctx
  USING (assigned_to = ahc_ctx_user_id())
  WITH CHECK (assigned_to = ahc_ctx_user_id());
--> statement-breakpoint

DROP POLICY IF EXISTS invoices_technician_insert ON invoices;
--> statement-breakpoint
CREATE POLICY invoices_technician_insert ON invoices FOR INSERT TO ahc_technician_ctx
  WITH CHECK (
    submitted_by = ahc_ctx_user_id()
    AND EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.id = job_id AND (j.created_by = ahc_ctx_user_id() OR j.assigned_to = ahc_ctx_user_id())
    )
  );
