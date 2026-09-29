import { formatDateDmy, istDateString } from '../../shared/dates.ts';
import { formatInr } from '../../shared/money.ts';
import { formatPhoneForDisplay } from '../../shared/phone.ts';

export { formatDateDmy, formatInr, formatPhoneForDisplay };

/** "12 min", "3 h", "2 d" since the given ISO time. */
export function ageLabel(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** IST time of day, e.g. "4:05 pm". */
export function timeIst(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** IST date and time, e.g. "28/09/2026 4:05 pm". */
export function dateTimeIst(iso: string): string {
  return `${formatDateDmy(istDateString(new Date(iso)))} ${timeIst(iso)}`;
}

export function rupeesLabel(rupees: number): string {
  return formatInr(rupees * 100);
}

/** Whole rupees with Indian grouping, no paise: 123456789 paise → "₹12,34,568". */
export function inrWhole(paise: number): string {
  const full = formatInr(Math.round(paise / 100) * 100);
  return full.replace(/\.00$/, '');
}

/** Indian compact money: ₹950 · ₹12.4K · ₹3.25L · ₹1.2Cr (for tiles, axes and tooltips). */
export function inrCompact(paise: number): string {
  const rupees = paise / 100;
  const sign = rupees < 0 ? '-' : '';
  const abs = Math.abs(rupees);
  const trim = (n: number, digits: number) => n.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7, 2)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5, 2)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3, 1)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

/** Percentage change current vs previous; null when there is no previous value to compare. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Axis/tooltip label for a trend bucket ("YYYY-MM-DD"). */
export function bucketLabel(bucket: string, granularity: 'day' | 'week' | 'month'): string {
  const [y, m, d] = bucket.split('-').map(Number) as [number, number, number];
  if (granularity === 'month') return `${MONTHS[m - 1]} ${String(y).slice(2)}`;
  return `${d} ${MONTHS[m - 1]}`;
}
