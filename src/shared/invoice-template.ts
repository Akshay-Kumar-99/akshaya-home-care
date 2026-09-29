import { formatDateDmy } from './dates.ts';
import { formatInr } from './money.ts';
import { formatPhoneForDisplay } from './phone.ts';

// The ONE customer message format. Changing the wording means bumping
// INVOICE_TEMPLATE_VERSION; issued invoices keep their stored snapshot forever.
// It must never contain spare cost, profit or margin.
export const INVOICE_TEMPLATE_VERSION = 1;

export interface InvoiceMessageInput {
  customerName: string;
  /** null renders the preview placeholder used before the number is assigned. */
  invoiceNumber: number | null;
  /** IST calendar date, "YYYY-MM-DD". */
  invoiceDate: string;
  totalPaise: number;
  /** Official business phone in E.164, from settings. */
  officialPhoneE164: string;
}

export const NUMBER_PLACEHOLDER = '(assigned on copy)';

export function formatInvoiceNumber(invoiceNumber: number): string {
  return `INV-${invoiceNumber}`;
}

export function renderInvoiceMessage(input: InvoiceMessageInput): string {
  const number =
    input.invoiceNumber === null ? NUMBER_PLACEHOLDER : formatInvoiceNumber(input.invoiceNumber);
  return [
    `Hello ${input.customerName.trim()},`,
    '',
    'Here are the details of your invoice from Akshaya Home Care.',
    '------------------------------------',
    `Invoice Number: ${number}`,
    `Invoice Date: ${formatDateDmy(input.invoiceDate)}`,
    `Invoice Total: ${formatInr(input.totalPaise)}`,
    '------------------------------------',
    '90-day warranty on the same fault serviced (parts excluded).',
    `For any queries, please call or message us on ${formatPhoneForDisplay(input.officialPhoneE164)}.`,
    '',
    'Thanks for choosing Akshaya Home Care!',
    '',
    'Best regards,',
    'Akshaya Home Care',
  ].join('\n');
}
