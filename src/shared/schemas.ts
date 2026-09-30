import { z } from 'zod';
import { MAX_INVOICE_RUPEES, PIN_MAX_LENGTH, TECHNICIAN_MODES } from './constants.ts';
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

const PaymentSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('paid'), mode: z.enum(['cash', 'upi', 'other']) }),
  z.object({ status: z.literal('unpaid') }),
]);

/** The money-and-payment part of any invoice raised from the field. */
const InvoiceFields = {
  serviceDescription: z.string().trim().min(1).max(300),
  /** 0 only on a warranty service (free visit); see `positiveUnlessWarranty`. */
  totalRupees: Rupees.min(0),
  spareCostRupees: Rupees.min(0),
  /** Must be true when spare cost exceeds the total (negative margin). */
  confirmNegativeMargin: z.boolean().default(false),
  /** Ignored when the total is 0 (nothing to pay). */
  payment: PaymentSchema,
  /**
   * Warranty service (owner, 30 Sep 2026): the earlier invoice whose 90-day service warranty
   * covers this visit. The server checks it is issued, for the same phone, and still running.
   */
  warrantyOfInvoiceId: z.uuid().nullable().default(null),
};

const negativeMarginConfirmed = <T extends { spareCostRupees: number; totalRupees: number; confirmNegativeMargin: boolean }>(v: T) =>
  v.spareCostRupees <= v.totalRupees || v.confirmNegativeMargin;
const NEGATIVE_MARGIN_ISSUE = {
  message: 'Spare cost is more than the total. Confirm to save anyway.',
  path: ['confirmNegativeMargin'],
};
const positiveUnlessWarranty = <T extends { totalRupees: number; warrantyOfInvoiceId: string | null }>(v: T) =>
  v.totalRupees >= 1 || v.warrantyOfInvoiceId !== null;
const TOTAL_REQUIRED_ISSUE = { message: 'Enter the total (at least ₹1).', path: ['totalRupees'] };

/** Technician (or admin) job submission. Amounts are whole rupees; the server stores paise. */
export const SubmissionInputSchema = z
  .object({
    idempotencyKey: z.uuid(),
    phone: PhoneSchema,
    customerName: z.string().trim().min(1).max(80),
    areaId: z.uuid().nullable(),
    applianceTypeKey: z.string().min(1).max(40),
    brandId: z.uuid().nullable(),
    ...InvoiceFields,
  })
  .refine(positiveUnlessWarranty, TOTAL_REQUIRED_ISSUE)
  .refine(negativeMarginConfirmed, NEGATIVE_MARGIN_ISSUE);

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

// ---------------------------------------------------------------- work allocation

/** A new work order, created and assigned by the Master or Admin Technician. */
export const WorkOrderInputSchema = z.object({
  phone: PhoneSchema,
  customerName: z.string().trim().min(1).max(80),
  areaId: z.uuid().nullable(),
  visitAddress: z.string().trim().max(300).nullable(),
  applianceTypeKey: z.string().min(1).max(40),
  brandId: z.uuid().nullable(),
  complaint: z.string().trim().min(3).max(500),
  /** ISO timestamp of the planned visit. */
  scheduledAt: z.iso.datetime({ offset: true }),
  assignedTo: z.uuid(),
});
export type WorkOrderInput = z.infer<typeof WorkOrderInputSchema>;

/** Re-assign / reschedule / correct an open work order. Only the fields sent change. */
export const WorkOrderUpdateSchema = z
  .object({
    assignedTo: z.uuid().optional(),
    scheduledAt: z.iso.datetime({ offset: true }).optional(),
    complaint: z.string().trim().min(3).max(500).optional(),
    visitAddress: z.string().trim().max(300).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
export type WorkOrderUpdate = z.infer<typeof WorkOrderUpdateSchema>;

/** A technician completes an assigned job and raises its invoice (offline-safe, idempotent). */
export const WorkCompleteSchema = z
  .object({
    idempotencyKey: z.uuid(),
    brandId: z.uuid().nullable(),
    ...InvoiceFields,
  })
  .refine(positiveUnlessWarranty, TOTAL_REQUIRED_ISSUE)
  .refine(negativeMarginConfirmed, NEGATIVE_MARGIN_ISSUE);
export type WorkCompleteInput = z.infer<typeof WorkCompleteSchema>;

// ---------------------------------------------------------------- team management (Master)

export const UsernameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/i, 'Use 3–32 letters, digits, dot, dash or underscore');

export const CreateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60),
    username: UsernameSchema,
    role: z.enum(['admin_technician', 'technician']),
    technicianMode: z.enum(TECHNICIAN_MODES).nullable(),
    password: z.string().min(1).max(256),
    pin: z.string().max(PIN_MAX_LENGTH).nullable(),
    /** Ask them to set their own password (and PIN) at first sign-in. */
    mustChange: z.boolean().default(true),
  })
  .refine((v) => (v.role === 'technician') === (v.technicianMode !== null), {
    message: 'Choose Invoice only or Invoice + Work allocation',
    path: ['technicianMode'],
  })
  .refine((v) => v.role !== 'admin_technician' || !!v.pin, { message: 'A PIN is required for the Admin Technician', path: ['pin'] });
export type CreateUserInput = z.infer<typeof CreateUserSchema>;

export const UpdateUserSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    username: UsernameSchema.optional(),
    technicianMode: z.enum(TECHNICIAN_MODES).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

/** Master sets a specific password and/or PIN for someone (PIN only for office roles). */
/** Master: business settings used on every invoice message. */
export const BusinessSettingsSchema = z.object({
  /** Terms & Conditions link (e.g. a Google Drive PDF shared "Anyone with the link"); null removes it. */
  termsUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/\S+$/, 'Paste the full link, starting with https://')
    .nullable(),
  officialPhone: PhoneSchema,
});
export type BusinessSettingsInput = z.infer<typeof BusinessSettingsSchema>;

export const SetCredentialsSchema = z
  .object({
    password: z.string().min(1).max(256).optional(),
    pin: z.string().max(PIN_MAX_LENGTH).optional(),
    mustChange: z.boolean().default(true),
  })
  .refine((v) => v.password !== undefined || v.pin !== undefined, 'Nothing to change');
export type SetCredentialsInput = z.infer<typeof SetCredentialsSchema>;
