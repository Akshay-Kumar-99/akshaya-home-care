// Money is always integer paise. Rupee input is whole rupees only (per spec); display uses
// the Indian digit grouping (12,34,567.00) and the ₹ sign.

export function rupeesToPaise(rupees: number): number {
  if (!Number.isSafeInteger(rupees) || rupees < 0) {
    throw new RangeError(`rupees must be a non-negative whole number, got ${rupees}`);
  }
  const paise = rupees * 100;
  if (!Number.isSafeInteger(paise)) throw new RangeError('amount too large');
  return paise;
}

/** Parses user input such as "2300", "2,300" or " 2,300 " into whole rupees; returns null if invalid. */
export function parseWholeRupees(input: string): number | null {
  const cleaned = input.trim().replace(/,/g, '');
  if (!/^\d{1,9}$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** Groups an unsigned digit string the Indian way: last three digits, then pairs. */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + lastThree;
}

/** 230000 → "₹2,300.00"; 1234567800 → "₹1,23,45,678.00". */
export function formatInr(paise: number): string {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`paise must be an integer, got ${paise}`);
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const fraction = (abs % 100).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₹${groupIndian(rupees)}.${fraction}`;
}
