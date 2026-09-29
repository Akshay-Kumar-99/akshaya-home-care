import type { RoleKey } from './constants.ts';

// Response shapes shared by the server and the web app. Each role has its own DTO:
// technician-facing shapes contain no profit, margin or customer message by construction.

export type InvoiceState = 'submitted' | 'issued' | 'void' | 'rejected';
export type PaymentMode = 'cash' | 'upi' | 'other';

export interface SessionInfo {
  authenticated: true;
  locked: boolean;
  pinEnabled: boolean;
  mustChange: boolean;
  user: { id: string; username: string; displayName: string; role: RoleKey };
  permissions: string[];
  kind: 'mobile' | 'desktop';
  idleTimeoutMinutes: number;
  absoluteExpiresAt: string;
}

export interface LookupsResponse {
  applianceTypes: Array<{ key: string; label: string }>;
  areas: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  servicePresets: string[];
}

/** Technician view of their own submission. No profit, no message, no WhatsApp link. */
export interface MySubmission {
  id: string;
  state: InvoiceState;
  invoiceNumber: number | null;
  invoiceDate: string;
  submittedAt: string;
  customerName: string;
  phone: string;
  area: string | null;
  appliance: string;
  brand: string | null;
  serviceDescription: string;
  totalPaise: number;
  spareCostPaise: number;
  paymentMode: PaymentMode | null;
  rejectedReason: string | null;
  editedByOffice: boolean;
}

/** Work Inv card (checkers only). */
export interface QueueCard {
  id: string;
  state: 'submitted' | 'issued';
  /** An issued item put back in the queue: Copy re-sends the stored message. */
  requeued: boolean;
  invoiceNumber: number | null;
  invoiceDate: string;
  submittedAt: string;
  technicianName: string;
  customerName: string;
  phone: string;
  areaId: string | null;
  area: string | null;
  applianceTypeKey: string;
  appliance: string;
  brandId: string | null;
  brand: string | null;
  serviceDescription: string;
  totalPaise: number;
  spareCostPaise: number;
  paymentMode: PaymentMode | null;
  negativeMargin: boolean;
  edited: boolean;
  possibleDuplicate: boolean;
  /** Exact customer message; for unissued items the number shows "(assigned on copy)". */
  preview: string;
  copiedByName: string | null;
  copiedAt: string | null;
  copyCount: number;
}

export interface QueueResponse {
  items: QueueCard[];
  queueAlertHours: number;
}

export interface CopyResponse {
  outcome: 'issued' | 'recopied';
  invoiceNumber: number;
  message: string;
  customerName: string;
  phone: string;
}

export interface QueueVersion {
  version: number;
  pendingCount: number;
  oldestPendingAt: string | null;
  queueAlertHours: number;
}

/** Admin list row (checkers and Master). */
export interface InvoiceRow {
  id: string;
  state: InvoiceState;
  invoiceNumber: number | null;
  invoiceDate: string;
  submittedAt: string;
  technicianName: string;
  customerName: string;
  phone: string;
  area: string | null;
  appliance: string;
  totalPaise: number;
  spareCostPaise: number;
  grossProfitPaise: number;
  paymentMode: PaymentMode | null;
  selfIssued: boolean;
  edited: boolean;
  negativeMargin: boolean;
  voidRequestPending: boolean;
}

export interface InvoiceDetail extends InvoiceRow {
  serviceDescription: string;
  brand: string | null;
  message: string | null;
  issuedByName: string | null;
  issuedAt: string | null;
  rejectedReason: string | null;
  voidReason: string | null;
  warrantyExpiresAt: string;
  history: Array<{ at: string; action: string; actorName: string | null; reason: string | null }>;
}

// ---------------------------------------------------------------- analytics (Master only)

export type Granularity = 'day' | 'week' | 'month';

export interface AnalyticsKpis {
  /** Sales: total of issued invoices dated in the period (void/rejected excluded). */
  revenuePaise: number;
  /** Expense: spare cost on those invoices (the only cost the app records today). */
  expensePaise: number;
  grossProfitPaise: number;
  /** Gross profit ÷ revenue × 100; null when there is no revenue. */
  marginPct: number | null;
  invoices: number;
  avgTicketPaise: number | null;
  customers: number;
  /** Share of this period's customers who had been served before (or more than once). */
  repeatCustomerPct: number | null;
  /** Issued in the period but not recorded as paid. */
  outstandingPaise: number;
  /** Submitted jobs dated in the period that are not issued yet (pipeline). */
  pendingCount: number;
  pendingPaise: number;
}

export interface AnalyticsOverview {
  range: { from: string; to: string; days: number; granularity: Granularity };
  previousRange: { from: string; to: string };
  kpis: AnalyticsKpis;
  previous: AnalyticsKpis;
  trend: Array<{ bucket: string; revenuePaise: number; expensePaise: number; invoices: number }>;
  byArea: Array<{ area: string; revenuePaise: number; invoices: number; grossProfitPaise: number }>;
  byCustomer: Array<{
    phone: string;
    name: string;
    area: string | null;
    invoices: number;
    revenuePaise: number;
    grossProfitPaise: number;
    lastInvoiceDate: string;
  }>;
  byAppliance: Array<{ appliance: string; revenuePaise: number; invoices: number }>;
  byTechnician: Array<{
    name: string;
    role: RoleKey;
    invoices: number;
    revenuePaise: number;
    grossProfitPaise: number;
    avgTicketPaise: number | null;
    submitted: number;
    editedPct: number | null;
    rejectedPct: number | null;
    avgMinutesToIssue: number | null;
  }>;
  paymentMix: { cashPaise: number; upiPaise: number; otherPaise: number; unpaidPaise: number };
  quality: {
    selfIssuedPct: number | null;
    negativeMarginCount: number;
    warrantyCallbacks: number;
    warrantyCallbackPct: number | null;
    voided: number;
    rejected: number;
  };
}

export interface CustomerHistory {
  phone: string;
  name: string;
  area: string | null;
  lifetimeRevenuePaise: number;
  lifetimeInvoices: number;
  firstInvoiceDate: string | null;
  invoices: Array<{
    id: string;
    invoiceNumber: number | null;
    state: InvoiceState;
    invoiceDate: string;
    appliance: string;
    serviceDescription: string;
    totalPaise: number;
    spareCostPaise: number;
    warrantyExpiresAt: string;
  }>;
}

export interface VoidRequestRow {
  id: string;
  invoiceId: string;
  invoiceNumber: number;
  customerName: string;
  totalPaise: number;
  reason: string;
  requestedByName: string;
  createdAt: string;
  status: 'pending' | 'approved' | 'rejected';
}
