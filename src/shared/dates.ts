import { BUSINESS_TIME_ZONE } from './constants.ts';

/** Calendar date in IST as "YYYY-MM-DD" (the format Postgres `date` columns use). */
export function istDateString(instant: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return parts; // en-CA formats as YYYY-MM-DD
}

/** "2026-09-28" → "28/09/2026" */
export function formatDateDmy(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new RangeError(`expected YYYY-MM-DD, got ${isoDate}`);
  const [, y, m, d] = match;
  return `${d}/${m}/${y}`;
}
