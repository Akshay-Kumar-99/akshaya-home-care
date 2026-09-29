// Customer phones are Indian mobile numbers stored as E.164 (+91XXXXXXXXXX).
// [ASSUMPTION] Customers are reached on mobile numbers (WhatsApp); landlines are not accepted.

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

/**
 * Normalises "98414 59657", "+91-98414-59657", "091 9841459657", "919841459657" etc.
 * to "+919841459657". Returns null for anything that is not a valid Indian mobile number.
 */
export function normalizeIndianMobile(input: string): string | null {
  let digits = input.trim();
  if (!/^[+\d\s\-().]+$/.test(digits)) return null;
  const hadPlus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');

  if (hadPlus) {
    if (!digits.startsWith('91')) return null;
    digits = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith('91')) {
    digits = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith('091')) {
    digits = digits.slice(3);
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return INDIAN_MOBILE.test(digits) ? `+91${digits}` : null;
}

/** "+919841459657" → "9841459657" */
export function nationalNumber(e164: string): string {
  return e164.startsWith('+91') ? e164.slice(3) : e164.replace(/^\+/, '');
}

/** "+919841459657" → "+91 98414 59657" */
export function formatPhoneForDisplay(e164: string): string {
  const national = nationalNumber(e164);
  return /^\d{10}$/.test(national) ? `+91 ${national.slice(0, 5)} ${national.slice(5)}` : e164;
}
