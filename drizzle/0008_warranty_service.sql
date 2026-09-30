-- Warranty service (owner, 30 Sep 2026): a repeat visit covered by an earlier invoice's 90-day
-- service warranty. It links to that invoice, may be free (₹0) or carry a visit charge, and gives
-- no new warranty of its own: the cover stays with the original invoice.
ALTER TABLE "invoices" ADD COLUMN "warranty_of_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warranty_of_invoice_id_invoices_id_fk" FOREIGN KEY ("warranty_of_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_warranty_of_idx" ON "invoices" USING btree ("warranty_of_invoice_id");--> statement-breakpoint
-- Changed in place (PostgreSQL 17+), so the column keeps its privileges.
ALTER TABLE "invoices" ALTER COLUMN "warranty_expires_at" SET EXPRESSION AS (case when warranty_of_invoice_id is null then invoice_date + 90 end);--> statement-breakpoint
-- Only a warranty service may be free (₹0).
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_total_positive_ck";--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total_positive_ck" CHECK ("invoices"."total_paise" > 0 or ("invoices"."warranty_of_invoice_id" is not null and "invoices"."total_paise" = 0));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_warranty_not_self_ck" CHECK ("invoices"."warranty_of_invoice_id" is null or "invoices"."warranty_of_invoice_id" <> "invoices"."id");--> statement-breakpoint
-- Technicians (row-level security role) may link their own submission to the covering invoice.
-- The server checks that invoice first: issued, same customer phone, warranty still running.
GRANT SELECT ("warranty_of_invoice_id"), INSERT ("warranty_of_invoice_id") ON "invoices" TO ahc_technician_ctx;
--> statement-breakpoint
-- Yes/no check used when a warranty service is saved: is this invoice issued, for this phone,
-- not itself a warranty service, and is its warranty still running (IST)? SECURITY DEFINER, so a
-- technician can ask without being able to read other technicians' invoices.
CREATE OR REPLACE FUNCTION ahc_warranty_cover_ok(p_invoice uuid, p_phone text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM invoices i
    JOIN jobs j ON j.id = i.job_id
    JOIN customers c ON c.id = j.customer_id
    WHERE i.id = p_invoice
      AND i.state = 'issued'
      AND i.warranty_of_invoice_id IS NULL
      AND c.phone_e164 = p_phone
      AND i.warranty_expires_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION ahc_warranty_cover_ok(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION ahc_warranty_cover_ok(uuid, text) TO ahc_technician_ctx;
