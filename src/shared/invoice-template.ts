import type { PaymentMode } from './api-types.ts';
import { formatDateDmy } from './dates.ts';
import { formatInr } from './money.ts';
import { formatPhoneForDisplay } from './phone.ts';

// The ONE customer message format. Changing the wording means bumping
// INVOICE_TEMPLATE_VERSION; issued invoices keep their stored snapshot forever.
// It must never contain spare cost, profit or margin.
//
// Version 2 (owner, 30 Sep 2026): WhatsApp *bold* labels and blank lines instead of long dash
// rules (those wrapped on phones), the service done and whether it is paid, the warranty stated as
// covering our service only, an optional Terms & Conditions link, and warranty services
// linked to the invoice that covers them.
export const INVOICE_TEMPLATE_VERSION = 2;

export interface InvoiceMessageInput {
  customerName: string;
  /** null renders the preview placeholder used before the number is assigned. */
  invoiceNumber: number | null;
  /** IST calendar date, "YYYY-MM-DD". */
  invoiceDate: string;
  totalPaise: number;
  /** Official business phone in E.164, from settings. */
  officialPhoneE164: string;
  applianceLabel: string;
  serviceDescription: string;
  /** How it was paid (only paid / not paid is shown); null = not paid yet. */
  paymentMode: PaymentMode | null;
  /** Last day of the service warranty, "YYYY-MM-DD" (the covering invoice's, for a warranty service). */
  warrantyUntil: string;
  /** Set on a warranty service: the number of the invoice whose warranty covers this visit. */
  warrantyForInvoiceNumber: number | null;
  /** Terms & Conditions link from settings (e.g. a Google Drive PDF); omitted when not set. */
  termsUrl: string | null;
}

export const NUMBER_PLACEHOLDER = '(assigned on copy)';

export function formatInvoiceNumber(invoiceNumber: number): string {
  return `INV-${invoiceNumber}`;
}

export function renderInvoiceMessage(input: InvoiceMessageInput): string {
  const number = input.invoiceNumber === null ? NUMBER_PLACEHOLDER : formatInvoiceNumber(input.invoiceNumber);
  // Paid or not only: the mode (cash / UPI) stays internal (owner, 30 Sep 2026).
  const payment = input.paymentMode ? 'Paid' : 'Pending';
  const until = formatDateDmy(input.warrantyUntil);
  const covering = input.warrantyForInvoiceNumber === null ? null : formatInvoiceNumber(input.warrantyForInvoiceNumber);
  const service = [input.applianceLabel.trim(), input.serviceDescription.trim()].filter(Boolean).join(' - ');

  const lines = [
    '*AKSHAYA HOME CARE*',
    'AC · Fridge · Washing Machine',
    '',
    `Hello ${input.customerName.trim()},`,
    'Thank you for choosing us.',
    '',
    `*Invoice:* ${number}`,
    `*Date:* ${formatDateDmy(input.invoiceDate)}`,
    `*Service:* ${service}`,
  ];
  if (covering) {
    lines.push(`*Warranty service* for ${covering}`);
    if (input.totalPaise === 0) {
      lines.push('*Amount:* No charge');
    } else {
      lines.push(`*Visit charge:* ${formatInr(input.totalPaise)}`, `*Payment:* ${payment}`);
    }
    lines.push(
      '',
      `*Warranty:* this visit is covered under ${covering} till ${until}. The warranty is on our service only; spare parts are not covered.`,
    );
  } else {
    lines.push(
      `*Amount:* ${formatInr(input.totalPaise)}`,
      `*Payment:* ${payment}`,
      '',
      `*Warranty:* 90 days on our service, till ${until}. Spare parts are not covered.`,
    );
  }
  if (input.termsUrl) lines.push('', `*Terms & Conditions:* ${input.termsUrl}`);
  lines.push('', `Queries: call or message ${formatPhoneForDisplay(input.officialPhoneE164)}`, '- Akshaya Home Care');
  return lines.join('\n');
}
