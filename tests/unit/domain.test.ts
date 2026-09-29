import { describe, expect, it } from 'vitest';
import { formatDateDmy, istDateString } from '../../src/shared/dates.ts';
import {
  formatInvoiceNumber,
  INVOICE_TEMPLATE_VERSION,
  renderInvoiceMessage,
} from '../../src/shared/invoice-template.ts';
import { formatInr, parseWholeRupees, rupeesToPaise } from '../../src/shared/money.ts';
import { formatPhoneForDisplay, normalizeIndianMobile } from '../../src/shared/phone.ts';
import { SubmissionInputSchema } from '../../src/shared/schemas.ts';

describe('money (integer paise)', () => {
  it('converts whole rupees to paise exactly', () => {
    expect(rupeesToPaise(2300)).toBe(230000);
    expect(rupeesToPaise(0)).toBe(0);
    expect(() => rupeesToPaise(10.5)).toThrow();
    expect(() => rupeesToPaise(-1)).toThrow();
  });

  it('parses rupee input with or without commas', () => {
    expect(parseWholeRupees('2300')).toBe(2300);
    expect(parseWholeRupees(' 2,300 ')).toBe(2300);
    expect(parseWholeRupees('1,00,000')).toBe(100000);
    expect(parseWholeRupees('23.50')).toBeNull();
    expect(parseWholeRupees('-5')).toBeNull();
    expect(parseWholeRupees('')).toBeNull();
  });

  it('formats with the ₹ sign and Indian digit grouping', () => {
    expect(formatInr(230000)).toBe('₹2,300.00');
    expect(formatInr(5)).toBe('₹0.05');
    expect(formatInr(99900)).toBe('₹999.00');
    expect(formatInr(10000000)).toBe('₹1,00,000.00');
    expect(formatInr(123456789)).toBe('₹12,34,567.89');
    expect(formatInr(1234567800)).toBe('₹1,23,45,678.00');
    expect(formatInr(-230000)).toBe('-₹2,300.00');
    expect(() => formatInr(1.5)).toThrow();
  });
});

describe('phone normalisation (E.164)', () => {
  it.each([
    ['9841459657', '+919841459657'],
    ['98414 59657', '+919841459657'],
    ['+91 98414-59657', '+919841459657'],
    ['+919841459657', '+919841459657'],
    ['919841459657', '+919841459657'],
    ['09841459657', '+919841459657'],
    ['(0) 98414 59657', '+919841459657'],
    ['6000000000', '+916000000000'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeIndianMobile(input)).toBe(expected);
  });

  it.each(['', '12345', '5841459657', '98414596571', '+1 202 555 0100', '044 2441 0000', 'abc9841459657'])(
    'rejects %s',
    (input) => {
      expect(normalizeIndianMobile(input)).toBeNull();
    },
  );

  it('formats a phone for display', () => {
    expect(formatPhoneForDisplay('+919841459657')).toBe('+91 98414 59657');
  });
});

describe('dates (IST)', () => {
  it('uses the IST calendar date, not UTC', () => {
    // 20:00 UTC on 28 Sep is 01:30 IST on 29 Sep.
    expect(istDateString(new Date('2026-09-28T20:00:00Z'))).toBe('2026-09-29');
    expect(istDateString(new Date('2026-09-28T18:00:00Z'))).toBe('2026-09-28');
  });

  it('formats dd/mm/yyyy', () => {
    expect(formatDateDmy('2026-09-28')).toBe('28/09/2026');
    expect(() => formatDateDmy('28-09-2026')).toThrow();
  });
});

describe('the single invoice message template', () => {
  const input = {
    customerName: '  Ravi Kumar ',
    invoiceNumber: 48213,
    invoiceDate: '2026-09-28',
    totalPaise: 230000,
    officialPhoneE164: '+919841459657',
  };

  it('renders exactly the approved format', () => {
    expect(renderInvoiceMessage(input)).toBe(
      [
        'Hello Ravi Kumar,',
        '',
        'Here are the details of your invoice from Akshaya Home Care.',
        '------------------------------------',
        'Invoice Number: INV-48213',
        'Invoice Date: 28/09/2026',
        'Invoice Total: ₹2,300.00',
        '------------------------------------',
        '90-day warranty on the same fault serviced (parts excluded).',
        'For any queries, please call or message us on +91 98414 59657.',
        '',
        'Thanks for choosing Akshaya Home Care!',
        '',
        'Best regards,',
        'Akshaya Home Care',
      ].join('\n'),
    );
    expect(INVOICE_TEMPLATE_VERSION).toBe(1);
  });

  it('shows the placeholder in previews before a number is assigned', () => {
    expect(renderInvoiceMessage({ ...input, invoiceNumber: null })).toContain(
      'Invoice Number: (assigned on copy)',
    );
  });

  it('never mentions spare cost, profit or margin', () => {
    const text = renderInvoiceMessage(input).toLowerCase();
    for (const word of ['spare', 'profit', 'margin', 'cost']) expect(text).not.toContain(word);
  });

  it('formats numbers as INV-<integer> with no padding', () => {
    expect(formatInvoiceNumber(10000)).toBe('INV-10000');
  });
});

describe('submission input schema', () => {
  const base = {
    idempotencyKey: '0d3c6c52-8a55-4d77-9a7e-4f7c8f0e2b11',
    phone: '98414 59657',
    customerName: 'Ravi',
    areaId: null,
    applianceTypeKey: 'ac_split',
    brandId: null,
    serviceDescription: 'Gas refilling',
    totalRupees: 2300,
    spareCostRupees: 800,
    payment: { status: 'paid' as const, mode: 'cash' as const },
  };

  it('normalises the phone', () => {
    expect(SubmissionInputSchema.parse(base).phone).toBe('+919841459657');
  });

  it('requires confirmation when spare cost exceeds the total', () => {
    expect(SubmissionInputSchema.safeParse({ ...base, spareCostRupees: 3000 }).success).toBe(false);
    expect(
      SubmissionInputSchema.safeParse({ ...base, spareCostRupees: 3000, confirmNegativeMargin: true }).success,
    ).toBe(true);
  });

  it('rejects fractional or zero totals and bad phones', () => {
    expect(SubmissionInputSchema.safeParse({ ...base, totalRupees: 0 }).success).toBe(false);
    expect(SubmissionInputSchema.safeParse({ ...base, totalRupees: 99.5 }).success).toBe(false);
    expect(SubmissionInputSchema.safeParse({ ...base, phone: '12345' }).success).toBe(false);
  });
});
