import { z } from 'zod';
import { MAX_INVOICE_RUPEES } from './constants.ts';
import { normalizeIndianMobile } from './phone.ts';

/** Technician (or admin) job submission. Amounts are whole rupees; the server stores paise. */
export const SubmissionInputSchema = z
  .object({
    idempotencyKey: z.uuid(),
    phone: z
      .string()
      .transform((value, ctx) => {
        const e164 = normalizeIndianMobile(value);
        if (!e164) {
          ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit mobile number' });
          return z.NEVER;
        }
        return e164;
      }),
    customerName: z.string().trim().min(1).max(80),
    areaId: z.uuid().nullable(),
    applianceTypeKey: z.string().min(1).max(40),
    brandId: z.uuid().nullable(),
    serviceDescription: z.string().trim().min(1).max(300),
    totalRupees: z.number().int().min(1).max(MAX_INVOICE_RUPEES),
    spareCostRupees: z.number().int().min(0).max(MAX_INVOICE_RUPEES),
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
