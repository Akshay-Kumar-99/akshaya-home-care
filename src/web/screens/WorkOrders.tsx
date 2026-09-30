import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { WorkOrder, WorkTechnician } from '../../shared/api-types.ts';
import { normalizeIndianMobile } from '../../shared/phone.ts';
import { useFeedback } from '../app/feedback.tsx';
import { useQueue } from '../app/queue.tsx';
import { Icon } from '../components/Icon.tsx';
import { WorkCard } from '../components/WorkCard.tsx';
import { Chips, Combobox, Dialog, EmptyState, Field, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { useLookups } from '../lib/lookups.ts';

type View = 'open' | 'completed' | 'cancelled';

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local"> in the device's time zone. */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nextHour(): Date {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function errorText(err: unknown): string {
  if (isNetworkError(err)) return t.offlineAction;
  if (err instanceof ApiError) return t.workErrors[err.code] ?? t.somethingWrong;
  return t.somethingWrong;
}

function useTechnicians(): WorkTechnician[] | null {
  const [list, setList] = useState<WorkTechnician[] | null>(null);
  useEffect(() => {
    api<{ technicians: WorkTechnician[] }>('/api/work/technicians')
      .then((res) => setList(res.technicians))
      .catch(() => setList([]));
  }, []);
  return list;
}

function TechnicianSelect(props: { list: WorkTechnician[] | null; value: string; onChange: (id: string) => void; error?: string | null }) {
  if (props.list && props.list.length === 0) return <p className="banner banner-warn">{t.noWorkTechnicians}</p>;
  return (
    <Field label={t.assignTo} icon="user" error={props.error}>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} disabled={!props.list}>
        <option value="">{t.chooseTechnician}</option>
        {(props.list ?? []).map((tech) => (
          <option key={tech.id} value={tech.id}>
            {tech.displayName} · {t.openJobsCount(tech.openJobs)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Work orders (Master on desktop, Admin Technician on the phone): assign a job to an
 * "Invoice + Work allocation" technician, then follow it until its invoice is raised.
 */
export function WorkOrders() {
  const { snapshot } = useQueue();
  const { toast } = useFeedback();
  const [view, setView] = useState<View>('open');
  const [items, setItems] = useState<WorkOrder[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [changing, setChanging] = useState<WorkOrder | null>(null);
  const [cancelling, setCancelling] = useState<WorkOrder | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: WorkOrder[] }>(`/api/work?view=${view}`);
      setItems(res.items);
    } catch (err) {
      if (!isNetworkError(err)) toast({ text: t.somethingWrong, tone: 'error' });
    }
  }, [view, toast]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  // A technician completing a job puts an invoice in Work Inv: the queue poll notices.
  useEffect(() => {
    if (snapshot) void load();
  }, [snapshot?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  const tabs: Array<[View, string]> = [
    ['open', t.viewOpen],
    ['completed', t.viewCompleted],
    ['cancelled', t.viewCancelled],
  ];

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t.navWorkOrders}</h2>
          <p className="page-sub">{t.workOrdersIntro}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
          <Icon name="plus" size={18} />
          {t.newWorkOrder}
        </button>
      </header>

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'tab tab-on' : 'tab'} onClick={() => setView(key)}>
            {label}
            {key === 'open' && view === 'open' && items ? <span className="tab-count">{items.length}</span> : null}
          </button>
        ))}
      </div>

      {items === null ? <Skeleton lines={6} /> : null}
      {items && items.length === 0 ? <EmptyState icon="clipboard" title={t.noWorkOrders} text={view === 'open' ? t.noWorkOrdersText : undefined} /> : null}

      <div className="cards cards-grid">
        {(items ?? []).map((work) => (
          <WorkCard key={work.id} work={work} office>
            {view === 'open' ? (
              <div className="row">
                <button type="button" className="btn btn-ghost grow" onClick={() => setChanging(work)}>
                  <Icon name="calendar" size={18} />
                  {t.changeWork}
                </button>
                <button type="button" className="btn btn-ghost btn-danger grow" onClick={() => setCancelling(work)}>
                  <Icon name="x" size={18} />
                  {t.cancelWork}
                </button>
              </div>
            ) : null}
          </WorkCard>
        ))}
      </div>

      {creating ? (
        <NewWorkOrderDialog
          onClose={(created) => {
            setCreating(false);
            if (created) {
              setView('open');
              void load();
            }
          }}
        />
      ) : null}
      {changing ? (
        <ChangeWorkDialog
          work={changing}
          onClose={(changed) => {
            setChanging(null);
            if (changed) void load();
          }}
        />
      ) : null}
      {cancelling ? (
        <CancelWorkDialog
          work={cancelling}
          onClose={(changed) => {
            setCancelling(null);
            if (changed) void load();
          }}
        />
      ) : null}
    </section>
  );
}

interface NewForm {
  phone: string;
  customerName: string;
  area: string;
  address: string;
  applianceTypeKey: string | null;
  brand: string;
  complaint: string;
  when: string;
  assignedTo: string;
}

type NewErrors = Partial<Record<keyof NewForm, string>>;

function NewWorkOrderDialog({ onClose }: { onClose: (created: boolean) => void }) {
  const lookups = useLookups();
  const technicians = useTechnicians();
  const { toast } = useFeedback();
  const [form, setForm] = useState<NewForm>(() => ({
    phone: '',
    customerName: '',
    area: '',
    address: '',
    applianceTypeKey: null,
    brand: '',
    complaint: '',
    when: toLocalInput(nextHour()),
    assignedTo: '',
  }));
  const [errors, setErrors] = useState<NewErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lookedUp = useRef<string | null>(null);

  const set = <K extends keyof NewForm>(key: K, value: NewForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  // Repeat customer: fill in name and area from the phone number.
  useEffect(() => {
    const phone = normalizeIndianMobile(form.phone);
    if (!phone || phone === lookedUp.current) return;
    lookedUp.current = phone;
    api<{ found: boolean; name?: string; areaId?: string | null }>(`/api/lookups/customer?phone=${encodeURIComponent(phone)}`)
      .then((res) => {
        if (!res.found) return;
        const areaName = lookups?.areas.find((a) => a.id === res.areaId)?.name ?? '';
        setForm((f) => ({ ...f, customerName: f.customerName || res.name || '', area: f.area || areaName }));
      })
      .catch(() => {});
  }, [form.phone, lookups]);

  const applianceOptions = useMemo(() => (lookups?.applianceTypes ?? []).map((a) => ({ value: a.key, label: a.label })), [lookups]);
  if (!lookups) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: NewErrors = {};
    const phone = normalizeIndianMobile(form.phone);
    if (!phone) found.phone = t.invalidPhone;
    if (!form.customerName.trim()) found.customerName = t.required;
    const area = form.area.trim() ? lookups!.areas.find((a) => a.name.toLowerCase() === form.area.trim().toLowerCase()) : null;
    if (area === undefined) found.area = t.chooseFromList;
    const brand = form.brand.trim() ? lookups!.brands.find((b) => b.name.toLowerCase() === form.brand.trim().toLowerCase()) : null;
    if (brand === undefined) found.brand = t.chooseFromList;
    if (!form.applianceTypeKey) found.applianceTypeKey = t.required;
    if (form.complaint.trim().length < 3) found.complaint = t.required;
    const when = new Date(form.when);
    if (!form.when || Number.isNaN(when.getTime())) found.when = t.required;
    if (!form.assignedTo) found.assignedTo = t.required;
    if (Object.keys(found).length > 0) return setErrors(found);

    setBusy(true);
    setFormError(null);
    try {
      await api('/api/work', {
        method: 'POST',
        body: {
          phone,
          customerName: form.customerName.trim(),
          areaId: area?.id ?? null,
          visitAddress: form.address.trim() || null,
          applianceTypeKey: form.applianceTypeKey,
          brandId: brand?.id ?? null,
          complaint: form.complaint.trim(),
          scheduledAt: when.toISOString(),
          assignedTo: form.assignedTo,
        },
      });
      const name = technicians?.find((x) => x.id === form.assignedTo)?.displayName ?? '';
      toast({ text: t.workAssigned(name), tone: 'ok' });
      onClose(true);
    } catch (err) {
      setFormError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.newWorkOrder} onClose={() => onClose(false)} wide>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="two-col">
          <Field label={t.phone} icon="phone" error={errors.phone}>
            <input type="tel" inputMode="tel" autoComplete="off" placeholder={t.phonePlaceholder} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label={t.customerName} icon="user" error={errors.customerName}>
            <input autoComplete="off" autoCapitalize="words" value={form.customerName} onChange={(e) => set('customerName', e.target.value)} />
          </Field>
        </div>
        <Combobox label={t.area} icon="pin" placeholder={t.areaPlaceholder} value={form.area} options={lookups.areas.map((a) => a.name)} onChange={(v) => set('area', v)} error={errors.area} />
        <Field label={t.visitAddress}>
          <input autoComplete="off" placeholder={t.visitAddressPlaceholder} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={300} />
        </Field>
        <Chips label={t.appliance} options={applianceOptions} value={form.applianceTypeKey} onChange={(v) => set('applianceTypeKey', v)} error={errors.applianceTypeKey} />
        <Combobox label={t.brand} placeholder={t.brandPlaceholder} value={form.brand} options={lookups.brands.map((b) => b.name)} onChange={(v) => set('brand', v)} error={errors.brand} />
        <Field label={t.complaint} error={errors.complaint}>
          <textarea rows={2} placeholder={t.complaintPlaceholder} value={form.complaint} onChange={(e) => set('complaint', e.target.value)} maxLength={500} />
        </Field>
        <div className="two-col">
          <Field label={t.visitTime} icon="calendar" error={errors.when}>
            <input type="datetime-local" value={form.when} onChange={(e) => set('when', e.target.value)} />
          </Field>
          <TechnicianSelect list={technicians} value={form.assignedTo} onChange={(id) => set('assignedTo', id)} error={errors.assignedTo} />
        </div>
        {formError ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} /> <span>{formError}</span>
          </p>
        ) : null}
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onClose(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn-primary grow" disabled={busy || technicians?.length === 0}>
            <Icon name="check" size={18} />
            {t.assign}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangeWorkDialog({ work, onClose }: { work: WorkOrder; onClose: (changed: boolean) => void }) {
  const technicians = useTechnicians();
  const { toast } = useFeedback();
  const [assignedTo, setAssignedTo] = useState(work.assignedToId ?? '');
  const [when, setWhen] = useState(work.scheduledAt ? toLocalInput(new Date(work.scheduledAt)) : toLocalInput(nextHour()));
  const [complaint, setComplaint] = useState(work.complaint ?? '');
  const [address, setAddress] = useState(work.address ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    if (assignedTo && assignedTo !== work.assignedToId) changes.assignedTo = assignedTo;
    const at = new Date(when);
    if (when && !Number.isNaN(at.getTime()) && at.toISOString() !== (work.scheduledAt && new Date(work.scheduledAt).toISOString())) {
      changes.scheduledAt = at.toISOString();
    }
    if (complaint.trim() && complaint.trim() !== (work.complaint ?? '')) changes.complaint = complaint.trim();
    if (address.trim() !== (work.address ?? '')) changes.visitAddress = address.trim() || null;
    if (Object.keys(changes).length === 0) return onClose(false);
    setBusy(true);
    setError(null);
    try {
      await api(`/api/work/${work.id}`, { method: 'PATCH', body: changes });
      toast({ text: t.workUpdated, tone: 'ok' });
      onClose(true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  // The current technician stays selectable even if they are no longer in the list.
  const list = technicians && work.assignedToId && !technicians.some((x) => x.id === work.assignedToId)
    ? [{ id: work.assignedToId, displayName: work.assignedToName ?? '', openJobs: 0 }, ...technicians]
    : technicians;

  return (
    <Dialog title={t.changeWorkTitle} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <p>
          <strong>{work.customerName}</strong> · {work.appliance}
        </p>
        <TechnicianSelect list={list} value={assignedTo} onChange={setAssignedTo} />
        <Field label={t.visitTime} icon="calendar">
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </Field>
        <Field label={t.complaint}>
          <textarea rows={2} value={complaint} onChange={(e) => setComplaint(e.target.value)} maxLength={500} />
        </Field>
        <Field label={t.visitAddress}>
          <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} /> <span>{error}</span>
          </p>
        ) : null}
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onClose(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn-primary grow" disabled={busy}>
            {t.save}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CancelWorkDialog({ work, onClose }: { work: WorkOrder; onClose: (changed: boolean) => void }) {
  const { toast } = useFeedback();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/api/work/${work.id}/cancel`, { method: 'POST', body: { reason: reason.trim() } });
      toast({ text: t.workCancelled, tone: 'ok' });
      onClose(true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.cancelWorkTitle} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <p>
          <strong>{work.customerName}</strong> · {work.appliance}
          {work.assignedToName ? ` · ${work.assignedToName}` : ''}
        </p>
        <Field label={t.cancelReason}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        </Field>
        {error ? (
          <p className="form-error" role="alert">
            <Icon name="alert" size={18} /> <span>{error}</span>
          </p>
        ) : null}
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onClose(false)}>
            {t.keepJob}
          </button>
          <button type="submit" className="btn btn-danger-solid grow" disabled={busy || reason.trim().length < 3}>
            {t.cancelWork}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
