import { z } from 'zod';
import { MAX_INVOICE_RUPEES } from './constants.ts';
import { normalizeIndianMobile } from './phone.ts';

/** Indian mobile number in any common spelling → E.164 (+91XXXXXXXXXX). */
export const PhoneSchema = z.string().transform((value, ctx) => {
  const e164 = normalizeIndianMobile(value);
  if (!e164) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit mobile number' });
    return z.NEVER;
  }
  return e164;
});

const Rupees = z.number().int().max(MAX_INVOICE_RUPEES);

/** Technician (or admin) job submission. Amounts are whole rupees; the server stores paise. */
export const SubmissionInputSchema = z
  .object({
    idempotencyKey: z.uuid(),
    phone: PhoneSchema,
    customerName: z.string().trim().min(1).max(80),
    areaId: z.uuid().nullable(),
    applianceTypeKey: z.string().min(1).max(40),
    brandId: z.uuid().nullable(),
    serviceDescription: z.string().trim().min(1).max(300),
    totalRupees: Rupees.min(1),
    spareCostRupees: Rupees.min(0),
    /** Must be true when spare cost exceeds the total (negative margin). */
    confirmNegativeMargin: z.boolean().default(false),
    payment: z.discriminatedUnion('status', [
      z.object({ status: z.literal('paid'), mode: z.enum(['cash', 'upi', 'other']) }),
      z.object({ status: z.literal('unpaid') }),
    ]),
  })
  .refine((v) => v.spareCostRupees <= v.totalRupees || v.confirmNegativeMargin, {
    message: 'Spare cost is more than the total. Confirm to save anyway.',
    path: ['confirmNegativeMargin'],
  });

export type SubmissionInput = z.infer<typeof SubmissionInputSchema>;
export type SubmissionInputRaw = z.input<typeof SubmissionInputSchema>;

/** Checker edit of a pending (not yet issued) item. Only the fields sent are changed. */
export const EditPendingSchema = z
  .object({
    customerName: z.string().trim().min(1).max(80).optional(),
    phone: PhoneSchema.optional(),
    areaId: z.uuid().nullable().optional(),
    applianceTypeKey: z.string().min(1).max(40).optional(),
    brandId: z.uuid().nullable().optional(),
    serviceDescription: z.string().trim().min(1).max(300).optional(),
    totalRupees: Rupees.min(1).optional(),
    spareCostRupees: Rupees.min(0).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');

export type EditPendingInput = z.infer<typeof EditPendingSchema>;

export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const CopySchema = z.object({
  /** The state the card showed: "submitted" = first copy (issues), "issued" = copy again. */
  expect: z.enum(['submitted', 'issued']),
});
