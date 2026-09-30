import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { CopyResponse, CustomerLookup, LookupsResponse, WarrantyCover, WorkOrder } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { normalizeIndianMobile } from '../../shared/phone.ts';
import { useFeedback } from '../app/feedback.tsx';
import { useUser } from '../app/session.tsx';
import { useCopyPhone, usePhoneStep } from '../components/CopyPhoneFirst.tsx';
import { Icon } from '../components/Icon.tsx';
import { Chips, Combobox, Field, MoneyInput, Section, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { copyWhenReady } from '../lib/clipboard.ts';
import { dateTimeIst, formatDateDmy, formatPhoneForDisplay, rupeesLabel } from '../lib/format.ts';
import { useLookups } from '../lib/lookups.ts';
import { outbox } from '../lib/outbox-idb.ts';
import type { SubmissionPayload } from '../lib/outbox.ts';
import { readDraft, writeDraft } from '../lib/drafts.ts';

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
  /** Warranty service: the covering invoice (owner, 30 Sep 2026). */
  warrantyOf: string | null;
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
  warrantyOf: null,
};

type Errors = Partial<Record<keyof FormState, string>>;
type KnownCustomer = Extract<CustomerLookup, { found: true }>;

function byName<T extends { name: string }>(list: T[], name: string): T | undefined {
  const needle = name.trim().toLowerCase();
  return list.find((x) => x.name.toLowerCase() === needle);
}

function toRupees(value: string): number | null {
  const digits = value.replace(/[,\s]/g, '');
  return /^\d{1,7}$/.test(digits) ? Number(digits) : null;
}

/** Service text as a list: "Gas refilling, PCB repair" → ["Gas refilling", "PCB repair"]. */
function serviceParts(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Client-side checks for fast feedback; the server validates again. */
function validate(form: FormState, lookups: LookupsResponse): { errors: Errors; payload?: Omit<SubmissionPayload, 'idempotencyKey'> } {
  const errors: Errors = {};
  const warranty = form.warrantyOf !== null;
  const phone = normalizeIndianMobile(form.phone);
  if (!phone) errors.phone = t.invalidPhone;
  if (!form.customerName.trim()) errors.customerName = t.required;
  const area = form.area.trim() ? byName(lookups.areas, form.area) : undefined;
  if (form.area.trim() && !area) errors.area = t.chooseFromList;
  const brand = form.brand.trim() ? byName(lookups.brands, form.brand) : undefined;
  if (form.brand.trim() && !brand) errors.brand = t.chooseFromList;
  if (!form.applianceTypeKey) errors.applianceTypeKey = t.required;
  if (!form.serviceDescription.trim()) errors.serviceDescription = t.required;
  // A warranty service is free unless a visit charge is entered.
  const total = warranty && form.total.trim() === '' ? 0 : toRupees(form.total);
  if (total === null || (total < 1 && !warranty)) errors.total = form.total ? t.wholeRupees : t.required;
  const spare = form.spare.trim() === '' ? 0 : toRupees(form.spare);
  if (spare === null) errors.spare = t.wholeRupees;
  if (total !== null && spare !== null && spare > total && !form.confirmNegative) {
    errors.confirmNegative = t.negativeMarginConfirm;
  }
  const free = total === 0;
  if (!form.payment && !free) errors.payment = t.required;
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
      payment: free || form.payment === 'unpaid' ? { status: 'unpaid' } : { status: 'paid', mode: form.payment! },
      warrantyOfInvoiceId: form.warrantyOf,
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

function sameForm(a: FormState, b: FormState): boolean {
  return (Object.keys(a) as Array<keyof FormState>).every((k) => a[k] === b[k]);
}

/**
 * The fast-entry job form (target: under 30 seconds on a phone).
 * mode "submit": technicians' "Save to Server" (offline-safe, goes to the Work Inv queue).
 *                With `work`, it completes that assigned work order instead: the customer and
 *                appliance come from the order, the technician fills in the work and amount.
 * mode "copy":   Master / Admin Technician's own jobs, in two taps: "Copy phone" copies the
 *                customer's number (for WhatsApp search), then "Copy invoice" creates the
 *                invoice and copies the message; the user pastes both in WhatsApp themselves.
 * A known phone shows the customer's recent visits and, if a service warranty is still
 * running, a "Warranty service" tick box that fills in the covered job (free, or a visit charge).
 */
export function JobForm({ mode, work, onDone }: { mode: 'submit' | 'copy'; work?: WorkOrder; onDone?: () => void }) {
  const user = useUser();
  const lookups = useLookups();
  const { toast, showCopyFallback } = useFeedback();
  const draftKey = `${user.user.id}.${work ? `work.${work.id}` : mode}`;
  const blank = useMemo(() => (work ? fromWork(work) : EMPTY), [work]);
  const [restored] = useState(() => {
    const draft = readDraft<FormState>(draftKey);
    return draft ? { ...draft, form: { ...EMPTY, ...draft.form } } : null;
  });
  const [form, setForm] = useState<FormState>(() => restored?.form ?? blank);
  const [showRestored, setShowRestored] = useState(restored !== null);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [customer, setCustomer] = useState<KnownCustomer | null>(null);
  // One key per job, kept across retries (and a restored form) so the server never stores it twice.
  const keyRef = useRef<string>(restored?.key ?? crypto.randomUUID());
  const lookedUp = useRef<string | null>(null);
  // Copy mode is two taps: the customer's phone first, then the invoice (owner, 30 Sep 2026).
  const typedPhone = mode === 'copy' ? normalizeIndianMobile(form.phone) : null;
  const phoneStep = usePhoneStep(typedPhone ? `form:${typedPhone}` : null);
  const copyPhone = useCopyPhone();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Keep the unfinished form on the phone.
  useEffect(() => {
    writeDraft(draftKey, sameForm(form, blank) ? null : { form, key: keyRef.current, savedAt: Date.now() });
  }, [form, blank, draftKey]);

  // Known phone: fill in name and area, show recent visits and any live service warranty.
  useEffect(() => {
    const phone = normalizeIndianMobile(form.phone);
    if (!phone) {
      lookedUp.current = null;
      setCustomer(null);
      return;
    }
    if (phone === lookedUp.current || !navigator.onLine) return;
    lookedUp.current = phone;
    api<CustomerLookup>(`/api/lookups/customer?phone=${encodeURIComponent(phone)}`)
      .then((res) => {
        if (lookedUp.current !== phone) return;
        if (!res.found) {
          setCustomer(null);
          setForm((f) => (f.warrantyOf ? { ...f, warrantyOf: null } : f));
          return;
        }
        setCustomer(res);
        const areaName = lookups?.areas.find((a) => a.id === res.areaId)?.name ?? '';
        setForm((f) => ({
          ...f,
          customerName: work ? f.customerName : f.customerName || res.name,
          area: work ? f.area : f.area || areaName,
          // A tick from another number (or an expired warranty) no longer applies.
          warrantyOf: f.warrantyOf && res.warranties.some((w) => w.invoiceId === f.warrantyOf) ? f.warrantyOf : null,
        }));
      })
      .catch(() => {});
  }, [form.phone, lookups, work]);

  const warranty = form.warrantyOf !== null;
  const total = warranty && form.total.trim() === '' ? 0 : toRupees(form.total);
  const spare = form.spare.trim() === '' ? 0 : toRupees(form.spare);
  const negative = total !== null && spare !== null && spare > total;
  const free = warranty && total === 0;
  const chosenCover = customer?.warranties.find((w) => w.invoiceId === form.warrantyOf) ?? null;

  const applianceOptions = useMemo(
    () => (lookups?.applianceTypes ?? []).map((a) => ({ value: a.key, label: a.label })),
    [lookups],
  );
  const areaNames = useMemo(() => (lookups?.areas ?? []).map((a) => a.name), [lookups]);
  const brandNames = useMemo(() => (lookups?.brands ?? []).map((b) => b.name), [lookups]);

  if (!lookups) return <Skeleton lines={10} />;

  function reset() {
    writeDraft(draftKey, null);
    setForm(EMPTY);
    setErrors({});
    setCustomer(null);
    setShowRestored(false);
    lookedUp.current = null;
    keyRef.current = crypto.randomUUID();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function finishWork() {
    writeDraft(draftKey, null);
    onDone?.();
  }

  /** Tick: fill in the covered job; the technician adjusts what was done and any visit charge. */
  function applyWarranty(cover: WarrantyCover | null) {
    setErrors((e) => ({ ...e, warrantyOf: undefined, total: undefined, payment: undefined }));
    if (!cover) {
      setForm((f) => ({ ...f, warrantyOf: null }));
      return;
    }
    setForm((f) => ({
      ...f,
      warrantyOf: cover.invoiceId,
      applianceTypeKey: work ? f.applianceTypeKey : cover.applianceTypeKey,
      brand: f.brand || (cover.brand ?? ''),
      area: f.area || (cover.area ?? ''),
      serviceDescription: [t.warrantyService, ...serviceParts(cover.serviceDescription)].join(', '),
      total: '',
      payment: null,
    }));
  }

  function toggleService(preset: string) {
    const parts = serviceParts(form.serviceDescription);
    const has = parts.some((p) => p.toLowerCase() === preset.toLowerCase());
    set('serviceDescription', (has ? parts.filter((p) => p.toLowerCase() !== preset.toLowerCase()) : [...parts, preset]).join(', '));
  }

  function serverErrors(err: unknown): boolean {
    if (!(err instanceof ApiError) || err.status !== 422) return false;
    const issues = (err.body?.issues as Array<{ path: string; message: string }> | undefined) ?? [];
    const mapped: Errors = {};
    for (const issue of issues) {
      const field =
        (
          {
            totalRupees: 'total',
            spareCostRupees: 'spare',
            confirmNegativeMargin: 'confirmNegative',
            warrantyOfInvoiceId: 'warrantyOf',
          } as Record<string, keyof FormState>
        )[issue.path] ?? (issue.path as keyof FormState);
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
      // Tap 1 copies the phone number, once the whole form is valid, so nothing is left to
      // fix after coming back from WhatsApp.
      if (!phoneStep.done) {
        copyPhone(payload.phone);
        phoneStep.markDone();
        return;
      }
      // Tap 2: start the clipboard write synchronously, inside the tap.
      const request = api<CopyResponse>('/api/invoices/issue-own', { method: 'POST', body: full });
      const copied = copyWhenReady(request.then((r) => r.message));
      setBusy(true);
      try {
        const result = await request;
        if (!(await copied)) showCopyFallback(result.message);
        toast({ text: t.copiedInvoice(formatInvoiceNumber(result.invoiceNumber)), tone: 'ok', durationMs: 6000 });
        phoneStep.clear();
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
            finishWork();
            return;
          }
        }
        toast({ text: t.fixAndResubmit, tone: 'error' });
        return;
      }
      const sentText = work ? t.workCompleted : t.submitted;
      toast({ text: outcome === 'sent' ? sentText : t.savedOffline, tone: outcome === 'sent' ? 'ok' : 'info', durationMs: 6000 });
      if (work) finishWork();
      else reset();
    } finally {
      setBusy(false);
    }
  }

  const warrantyBox =
    customer && customer.warranties.length > 0 ? (
      <div className={`warranty-box${errors.warrantyOf ? ' confirm-box-error' : ''}`}>
        <label className="check-row">
          <input
            type="checkbox"
            checked={warranty}
            onChange={(e) => applyWarranty(e.target.checked ? customer.warranties[0]! : null)}
          />
          <span className="stack-sm">
            <strong>{t.warrantyService}</strong>
            {customer.warranties.length === 1 || !warranty ? (
              <span className="muted small">
                {t.warrantyCoveredBy(
                  formatInvoiceNumber((chosenCover ?? customer.warranties[0]!).invoiceNumber),
                  (chosenCover ?? customer.warranties[0]!).appliance,
                  formatDateDmy((chosenCover ?? customer.warranties[0]!).warrantyUntil),
                )}
              </span>
            ) : null}
            <span className="muted small">{t.warrantyTickHint}</span>
          </span>
        </label>
        {warranty && customer.warranties.length > 1 ? (
          <Field label={t.warrantyWhich} icon="receipt">
            <select
              value={form.warrantyOf ?? ''}
              onChange={(e) => applyWarranty(customer.warranties.find((w) => w.invoiceId === e.target.value) ?? null)}
            >
              {customer.warranties.map((w) => (
                <option key={w.invoiceId} value={w.invoiceId}>
                  {t.warrantyCoveredBy(formatInvoiceNumber(w.invoiceNumber), w.appliance, formatDateDmy(w.warrantyUntil))}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        {errors.warrantyOf ? (
          <span className="field-error" role="alert">
            <Icon name="alert" size={14} /> {errors.warrantyOf}
          </span>
        ) : null}
      </div>
    ) : null;

  const history =
    customer && customer.visits.length > 0 && !work ? (
      <div className="visit-history">
        <span className="field-label">{t.recentVisits}</span>
        <ul className="meta">
          {customer.visits.map((v, i) => (
            <li key={i}>
              <Icon name={v.warrantyService ? 'checkCircle' : 'clock'} size={16} />
              <span>
                {formatDateDmy(v.date)} · {v.invoiceNumber ? formatInvoiceNumber(v.invoiceNumber) : t.visitPending} · {v.appliance} -{' '}
                {v.serviceDescription}
              </span>
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    <form className="job-form" onSubmit={submit} noValidate>
      {showRestored ? (
        <p className="banner banner-info" role="status">
          <Icon name="refresh" size={18} />
          <span className="grow">{t.draftRestored}</span>
          <button type="button" className="link-button" onClick={() => (work ? (setForm(blank), setShowRestored(false)) : reset())}>
            {t.startOver}
          </button>
        </p>
      ) : null}

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
          {warrantyBox}
        </Section>
      ) : (
        <Section title={t.sectionCustomer} icon="user">
          <Field label={t.phone} error={errors.phone} hint={customer ? t.knownCustomer : undefined} icon="phone">
            <input
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder={t.phonePlaceholder}
              value={form.phone}
              onChange={(e) => set('phone', e.target.value)}
            />
          </Field>
          {history}
          {warrantyBox}
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
          {lookups.servicePresets.map((p) => {
            const on = serviceParts(form.serviceDescription).some((x) => x.toLowerCase() === p.toLowerCase());
            return (
              <button key={p} type="button" className={`chip${on ? ' chip-on' : ''}`} aria-pressed={on} onClick={() => toggleService(p)}>
                <Icon name={on ? 'check' : 'plus'} size={14} />
                {p}
              </button>
            );
          })}
        </div>
      </Section>

      <Section title={t.sectionAmount} icon="receipt">
        <div className="two-col">
          <MoneyInput
            label={warranty ? t.visitCharge : t.total}
            value={form.total}
            onChange={(v) => set('total', v)}
            error={errors.total}
            hint={total !== null && total > 0 ? rupeesLabel(total) : warranty ? t.visitChargeHint : undefined}
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
        {free ? (
          <p className="muted small">
            <Icon name="checkCircle" size={14} /> {t.noChargeNote}
          </p>
        ) : (
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
        )}
      </Section>

      <div className="action-bar">
        <div className="action-total">
          <span className="muted small">{t.customerPays}</span>
          <strong>{free ? t.noCharge : total !== null && total > 0 ? rupeesLabel(total) : '₹0'}</strong>
        </div>
        {mode === 'copy' ? (
          <button type="submit" className="btn btn-primary btn-large grow" disabled={busy}>
            <Icon name={phoneStep.done ? 'copy' : 'phone'} />
            {phoneStep.done ? t.copyInvoice : t.copyPhone}
          </button>
        ) : (
          <button type="submit" className="btn btn-primary btn-large grow" disabled={busy}>
            <Icon name={work ? 'checkCircle' : 'cloud'} />
            {work ? t.completeWork : t.saveToServer}
          </button>
        )}
      </div>
      {mode === 'copy' && phoneStep.done ? (
        <button type="button" className="link-button" onClick={() => copyPhone(typedPhone ?? form.phone)}>
          {t.copyPhoneAgain}
        </button>
      ) : null}
    </form>
  );
}
