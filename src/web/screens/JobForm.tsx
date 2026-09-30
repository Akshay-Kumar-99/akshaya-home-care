import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CopyResponse, LookupsResponse, WorkOrder } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { normalizeIndianMobile } from '../../shared/phone.ts';
import { useFeedback } from '../app/feedback.tsx';
import { useUser } from '../app/session.tsx';
import { Icon } from '../components/Icon.tsx';
import { Chips, Combobox, Field, MoneyInput, Section, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { copyWhenReady } from '../lib/clipboard.ts';
import { dateTimeIst, formatPhoneForDisplay, rupeesLabel } from '../lib/format.ts';
import { useLookups } from '../lib/lookups.ts';
import { outbox } from '../lib/outbox-idb.ts';
import type { SubmissionPayload } from '../lib/outbox.ts';

type PaymentChoice = 'cash' | 'upi' | 'unpaid';

interface FormState {
  phone: string;
  customerName: string;
  area: string;
  applianceTypeKey: string | null;
  brand: string;
  serviceDescription: string;
  total: string;
  spare: string;
  payment: PaymentChoice | null;
  confirmNegative: boolean;
}

const EMPTY: FormState = {
  phone: '',
  customerName: '',
  area: '',
  applianceTypeKey: null,
  brand: '',
  serviceDescription: '',
  total: '',
  spare: '',
  payment: null,
  confirmNegative: false,
};

type Errors = Partial<Record<keyof FormState, string>>;

function byName<T extends { name: string }>(list: T[], name: string): T | undefined {
  const needle = name.trim().toLowerCase();
  return list.find((x) => x.name.toLowerCase() === needle);
}

function toRupees(value: string): number | null {
  const digits = value.replace(/[,\s]/g, '');
  return /^\d{1,7}$/.test(digits) ? Number(digits) : null;
}

/** Client-side checks for fast feedback; the server validates again. */
function validate(form: FormState, lookups: LookupsResponse): { errors: Errors; payload?: Omit<SubmissionPayload, 'idempotencyKey'> } {
  const errors: Errors = {};
  const phone = normalizeIndianMobile(form.phone);
  if (!phone) errors.phone = t.invalidPhone;
  if (!form.customerName.trim()) errors.customerName = t.required;
  const area = form.area.trim() ? byName(lookups.areas, form.area) : undefined;
  if (form.area.trim() && !area) errors.area = t.chooseFromList;
  const brand = form.brand.trim() ? byName(lookups.brands, form.brand) : undefined;
  if (form.brand.trim() && !brand) errors.brand = t.chooseFromList;
  if (!form.applianceTypeKey) errors.applianceTypeKey = t.required;
  if (!form.serviceDescription.trim()) errors.serviceDescription = t.required;
  const total = toRupees(form.total);
  if (total === null || total < 1) errors.total = form.total ? t.wholeRupees : t.required;
  const spare = form.spare.trim() === '' ? 0 : toRupees(form.spare);
  if (spare === null) errors.spare = t.wholeRupees;
  if (total !== null && spare !== null && spare > total && !form.confirmNegative) {
    errors.confirmNegative = t.negativeMarginConfirm;
  }
  if (!form.payment) errors.payment = t.required;
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    payload: {
      phone: phone!,
      customerName: form.customerName.trim(),
      areaId: area?.id ?? null,
      applianceTypeKey: form.applianceTypeKey!,
      brandId: brand?.id ?? null,
      serviceDescription: form.serviceDescription.trim(),
      totalRupees: total!,
      spareCostRupees: spare!,
      confirmNegativeMargin: form.confirmNegative,
      payment: form.payment === 'unpaid' ? { status: 'unpaid' } : { status: 'paid', mode: form.payment! },
    },
  };
}

function fromWork(work: WorkOrder): FormState {
  return {
    ...EMPTY,
    phone: work.phone,
    customerName: work.customerName,
    area: work.area ?? '',
    applianceTypeKey: work.applianceTypeKey,
    brand: work.brand ?? '',
  };
}

/**
 * The fast-entry job form (target: under 30 seconds on a phone).
 * mode "submit": technicians' "Save to Server" (offline-safe, goes to the Work Inv queue).
 *                With `work`, it completes that assigned work order instead: the customer and
 *                appliance come from the order, the technician fills in the work and amount.
 * mode "copy":   Master / Admin Technician "Copy invoice" for their own jobs: creates the
 *                invoice and copies the message; the user pastes it in WhatsApp themselves.
 */
export function JobForm({ mode, work, onDone }: { mode: 'submit' | 'copy'; work?: WorkOrder; onDone?: () => void }) {
  const user = useUser();
  const lookups = useLookups();
  const { toast, showCopyFallback } = useFeedback();
  const [form, setForm] = useState<FormState>(() => (work ? fromWork(work) : EMPTY));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [knownCustomer, setKnownCustomer] = useState(false);
  // One key per job, kept across retries so the server never stores it twice.
  const keyRef = useRef<string>(crypto.randomUUID());
  const lookedUp = useRef<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Repeat customer: a known phone fills in name and area.
  useEffect(() => {
    const phone = normalizeIndianMobile(form.phone);
    if (work || !phone || phone === lookedUp.current || !navigator.onLine) return;
    lookedUp.current = phone;
    api<{ found: boolean; name?: string; areaId?: string | null }>(`/api/lookups/customer?phone=${encodeURIComponent(phone)}`)
      .then((res) => {
        if (!res.found) return;
        const areaName = lookups?.areas.find((a) => a.id === res.areaId)?.name ?? '';
        setForm((f) => ({
          ...f,
          customerName: f.customerName || res.name || '',
          area: f.area || areaName,
        }));
        setKnownCustomer(true);
      })
      .catch(() => {});
  }, [form.phone, lookups, work]);

  const total = toRupees(form.total);
  const spare = form.spare.trim() === '' ? 0 : toRupees(form.spare);
  const negative = total !== null && spare !== null && spare > total;

  const applianceOptions = useMemo(
    () => (lookups?.applianceTypes ?? []).map((a) => ({ value: a.key, label: a.label })),
    [lookups],
  );
  const areaNames = useMemo(() => (lookups?.areas ?? []).map((a) => a.name), [lookups]);
  const brandNames = useMemo(() => (lookups?.brands ?? []).map((b) => b.name), [lookups]);

  if (!lookups) return <Skeleton lines={10} />;

  function reset() {
    setForm(EMPTY);
    setErrors({});
    setKnownCustomer(false);
    lookedUp.current = null;
    keyRef.current = crypto.randomUUID();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function serverErrors(err: unknown): boolean {
    if (!(err instanceof ApiError) || err.status !== 422) return false;
    const issues = (err.body?.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    const mapped: Errors = {};
    for (const issue of issues) {
      const field =
        ({ totalRupees: 'total', spareCostRupees: 'spare', confirmNegativeMargin: 'confirmNegative' } as Record<string, keyof FormState>)[
          issue.path
        ] ?? (issue.path as keyof FormState);
      mapped[field] = issue.message;
    }
    setErrors(Object.keys(mapped).length ? mapped : { serviceDescription: t.fixAndResubmit });
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { errors: found, payload } = validate(form, lookups!);
    if (!payload) {
      setErrors(found);
      document.querySelector('.field-invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const full: SubmissionPayload = { ...payload, idempotencyKey: keyRef.current };

    if (mode === 'copy') {
      // Start the clipboard write synchronously, inside the tap.
      const request = api<CopyResponse>('/api/invoices/issue-own', { method: 'POST', body: full });
      const copied = copyWhenReady(request.then((r) => r.message));
      setBusy(true);
      try {
        const result = await request;
        if (!(await copied)) showCopyFallback(result.message);
        toast({ text: t.copiedInvoice(formatInvoiceNumber(result.invoiceNumber)), tone: 'ok', durationMs: 6000 });
        reset();
      } catch (err) {
        if (!serverErrors(err)) toast({ text: isNetworkError(err) ? t.offlineAction : t.somethingWrong, tone: 'error' });
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const appliance = lookups!.applianceTypes.find((a) => a.key === full.applianceTypeKey)?.label ?? '';
      const outcome = await outbox.add({
        key: full.idempotencyKey,
        userId: user.user.id,
        payload: full,
        workJobId: work?.id,
        summary: {
          customerName: full.customerName,
          applianceLabel: appliance,
          totalRupees: full.totalRupees,
          spareCostRupees: full.spareCostRupees,
        },
      });
      if (outcome === 'rejected') {
        await outbox.discard(full.idempotencyKey);
        // Re-send directly to get the field errors to show.
        try {
          await api(work ? `/api/work/${work.id}/complete` : '/api/jobs', { method: 'POST', body: full });
        } catch (err) {
          if (serverErrors(err)) return;
          if (work) {
            toast({ text: t.workGone, tone: 'error' });
            onDone?.();
            return;
          }
        }
        toast({ text: t.fixAndResubmit, tone: 'error' });
        return;
      }
      const sentText = work ? t.workCompleted : t.submitted;
      toast({ text: outcome === 'sent' ? sentText : t.savedOffline, tone: outcome === 'sent' ? 'ok' : 'info', durationMs: 6000 });
      if (work) onDone?.();
      else reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="job-form" onSubmit={submit} noValidate>
      {work ? (
        <Section title={t.sectionCustomer} icon="user">
          <ul className="meta">
            <li>
              <Icon name="user" size={16} />
              <span>
                <strong>{work.customerName}</strong> · <a href={`tel:${work.phone}`}>{formatPhoneForDisplay(work.phone)}</a>
              </span>
            </li>
            {work.address || work.area ? (
              <li>
                <Icon name="pin" size={16} />
                <span>{[work.address, work.area].filter(Boolean).join(', ')}</span>
              </li>
            ) : null}
            <li>
              <Icon name="wrench" size={16} />
              <span>
                {work.appliance}
                {work.complaint ? ` · ${work.complaint}` : ''}
              </span>
            </li>
            {work.scheduledAt ? (
              <li>
                <Icon name="clock" size={16} />
                <span>{t.visitAt(dateTimeIst(work.scheduledAt))}</span>
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}
      {work ? null : (
      <Section title={t.sectionCustomer} icon="user">
        <Field label={t.phone} error={errors.phone} hint={knownCustomer ? t.knownCustomer : undefined} icon="phone">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder={t.phonePlaceholder}
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
        </Field>
        <Field label={t.customerName} error={errors.customerName} icon="user">
          <input autoComplete="off" autoCapitalize="words" value={form.customerName} onChange={(e) => set('customerName', e.target.value)} />
        </Field>
        <Combobox
          label={t.area}
          icon="pin"
          placeholder={t.areaPlaceholder}
          value={form.area}
          options={areaNames}
          onChange={(v) => set('area', v)}
          error={errors.area}
        />
      </Section>
      )}

      <Section title={t.sectionJob} icon="wrench">
        {work ? null : (
          <Chips
            label={t.appliance}
            options={applianceOptions}
            value={form.applianceTypeKey}
            onChange={(v) => set('applianceTypeKey', v)}
            error={errors.applianceTypeKey}
          />
        )}
        <Combobox
          label={t.brand}
          placeholder={t.brandPlaceholder}
          value={form.brand}
          options={brandNames}
          onChange={(v) => set('brand', v)}
          error={errors.brand}
        />
        <Field label={t.serviceDescription} error={errors.serviceDescription}>
          <textarea rows={2} value={form.serviceDescription} onChange={(e) => set('serviceDescription', e.target.value)} />
        </Field>
        <div className="chips chips-small" role="group" aria-label={t.quickPicks}>
          {lookups.servicePresets.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              onClick={() =>
                set('serviceDescription', form.serviceDescription.trim() ? `${form.serviceDescription.trim()}, ${p}` : p)
              }
            >
              <Icon name="plus" size={14} />
              {p}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t.sectionAmount} icon="receipt">
        <div className="two-col">
          <MoneyInput
            label={t.total}
            value={form.total}
            onChange={(v) => set('total', v)}
            error={errors.total}
            hint={total !== null && total > 0 ? rupeesLabel(total) : undefined}
          />
          <MoneyInput
            label={t.spareCost}
            value={form.spare}
            onChange={(v) => set('spare', v)}
            error={errors.spare}
            hint={spare ? rupeesLabel(spare) : undefined}
          />
        </div>
        {negative ? (
          <label className={`confirm-box${errors.confirmNegative ? ' confirm-box-error' : ''}`}>
            <input type="checkbox" checked={form.confirmNegative} onChange={(e) => set('confirmNegative', e.target.checked)} />
            <span>{t.negativeMarginConfirm}</span>
          </label>
        ) : null}
        <Chips<PaymentChoice>
          label={t.payment}
          segmented
          options={[
            { value: 'cash', label: t.paidCash },
            { value: 'upi', label: t.paidUpi },
            { value: 'unpaid', label: t.notPaid },
          ]}
          value={form.payment}
          onChange={(v) => set('payment', v)}
          error={errors.payment}
        />
      </Section>

      <div className="action-bar">
        <div className="action-total">
          <span className="muted small">{t.customerPays}</span>
          <strong>{total !== null && total > 0 ? rupeesLabel(total) : '₹0'}</strong>
        </div>
        <button type="submit" className="btn btn-primary btn-large grow" disabled={busy}>
          <Icon name={mode === 'copy' ? 'copy' : work ? 'checkCircle' : 'cloud'} />
          {mode === 'copy' ? t.copyInvoice : work ? t.completeWork : t.saveToServer}
        </button>
      </div>
    </form>
  );
}
