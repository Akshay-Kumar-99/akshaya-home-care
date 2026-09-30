import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CopyResponse, QueueCard, QueueResponse } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { normalizeIndianMobile } from '../../shared/phone.ts';
import { StepUpCancelled, useFeedback } from '../app/feedback.tsx';
import { isOverdue, useQueue } from '../app/queue.tsx';
import { useSession } from '../app/session.tsx';
import { Icon } from '../components/Icon.tsx';
import { PhoneThenInvoice } from '../components/CopyPhoneFirst.tsx';
import { Chips, Combobox, Dialog, EmptyState, Field, Initials, MoneyInput, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { copyWhenReady } from '../lib/clipboard.ts';
import { ageLabel, formatInr, formatPhoneForDisplay, timeIst } from '../lib/format.ts';
import { useLookups } from '../lib/lookups.ts';
import { enablePush, pushState, type PushState } from '../lib/push.ts';

type Tab = 'pending' | 'recent';

/**
 * Technician Work Inv. Primary user: the Admin Technician on an Android phone; the Master
 * uses the same screen on desktop. The server is the source of truth: lists are reloaded on
 * every queue change and whenever the app comes back to the foreground (e.g. from WhatsApp).
 */
export function WorkInv() {
  const { snapshot, poll, sound, setSound } = useQueue();
  const { can } = useSession();
  const { toast, showCopyFallback } = useFeedback();
  const [tab, setTab] = useState<Tab>('pending');
  const [pending, setPending] = useState<QueueCard[] | null>(null);
  const [recent, setRecent] = useState<QueueCard[] | null>(null);
  const [alertHours, setAlertHours] = useState(4);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<QueueCard | null>(null);
  const [rejecting, setRejecting] = useState<QueueCard | null>(null);
  const [push, setPush] = useState<PushState | null>(null);

  const load = useCallback(async (background: boolean) => {
    try {
      const [p, r] = await Promise.all([
        api<QueueResponse>('/api/workinv/pending', { background }),
        api<QueueResponse>('/api/workinv/recent', { background }),
      ]);
      setPending(p.items);
      setRecent(r.items);
      setAlertHours(p.queueAlertHours);
    } catch {
      // keep what is on screen; the poll retries
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  // Reload when the queue changes (another checker, a new submission).
  useEffect(() => {
    if (snapshot) void load(true);
  }, [snapshot?.version, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    pushState().then(setPush).catch(() => setPush('unsupported'));
  }, []);

  /** The second tap (after Copy phone): issues the number if needed and copies the message. */
  function copy(card: QueueCard): Promise<boolean> {
    const expect = card.state === 'submitted' ? 'submitted' : 'issued';
    // Start the clipboard write synchronously inside the tap (required on iOS and Android).
    const request = api<CopyResponse>(`/api/workinv/${card.id}/copy`, { method: 'POST', body: { expect } });
    const copied = copyWhenReady(request.then((r) => r.message));
    setBusyId(card.id);
    return request
      .then(async (result) => {
        if (!(await copied)) showCopyFallback(result.message);
        toast({ text: t.copiedFor(formatInvoiceNumber(result.invoiceNumber), result.customerName), tone: 'ok', durationMs: 6000 });
        setPending((items) => items?.filter((i) => i.id !== card.id) ?? null);
        return true;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === 'already_copied') {
          toast({ text: t.alreadyCopied(String(err.body?.by), timeIst(String(err.body?.at))), tone: 'error' });
        } else if (err instanceof ApiError && err.code === 'not_copyable') {
          toast({ text: t.notCopyable, tone: 'error' });
        } else {
          toast({ text: isNetworkError(err) ? t.offlineAction : t.somethingWrong, tone: 'error' });
        }
        return false;
      })
      .finally(() => {
        setBusyId(null);
        poll();
        void load(false);
      });
  }

  async function putBack(card: QueueCard) {
    setBusyId(card.id);
    try {
      await api(`/api/workinv/${card.id}/requeue`, { method: 'POST' });
      setTab('pending');
    } catch {
      toast({ text: t.somethingWrong, tone: 'error' });
    } finally {
      setBusyId(null);
      poll();
      void load(false);
    }
  }

  const overdue = isOverdue(snapshot);
  const list = tab === 'pending' ? pending : recent;
  const oldest = useMemo(() => (pending && pending.length ? ageLabel(pending[0]!.submittedAt) : '–'), [pending]);

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t.navWorkInv}</h2>
        </div>
        <div className="row">
          <button
            type="button"
            className={`icon-btn${sound ? ' icon-btn-on' : ''}`}
            onClick={() => setSound(!sound)}
            aria-pressed={sound}
            aria-label={sound ? t.soundOn : t.soundOff}
            title={sound ? t.soundOn : t.soundOff}
          >
            <Icon name={sound ? 'volume' : 'volumeOff'} />
          </button>
          {push === 'off' ? (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => enablePush().then(setPush).catch(() => toast({ text: t.somethingWrong, tone: 'error' }))}
            >
              <Icon name="bell" size={16} />
              {t.turnOnAlerts}
            </button>
          ) : null}
          {push === 'on' ? (
            <span className="pill pill-issued" title={t.alertsOn}>
              <Icon name="bell" size={14} />
              {t.alertsOn}
            </span>
          ) : null}
        </div>
      </header>

      <div className="stats">
        <div className={`stat${overdue ? ' stat-warn' : ''}`}>
          <span className="stat-label">{t.statPending}</span>
          <strong className="stat-value">{pending ? pending.length : '–'}</strong>
        </div>
        <div className={`stat${overdue ? ' stat-warn' : ''}`}>
          <span className="stat-label">{t.statOldest}</span>
          <strong className="stat-value">{oldest}</strong>
        </div>
        <div className="stat">
          <span className="stat-label">{t.statCopied}</span>
          <strong className="stat-value">{recent ? recent.length : '–'}</strong>
        </div>
      </div>

      {overdue && snapshot ? (
        <p className="banner banner-warn" role="alert">
          <Icon name="alert" size={18} /> {t.overdue(snapshot.pendingCount, snapshot.queueAlertHours)}
        </p>
      ) : null}
      {push === 'blocked' ? <p className="muted small">{t.alertsBlocked}</p> : null}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'pending'} className={tab === 'pending' ? 'tab tab-on' : 'tab'} onClick={() => setTab('pending')}>
          {t.pending}
          {pending ? <span className="tab-count">{pending.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'recent'} className={tab === 'recent' ? 'tab tab-on' : 'tab'} onClick={() => setTab('recent')}>
          {t.recentlyCopied}
        </button>
      </div>

      {list === null ? <Skeleton lines={6} /> : null}
      {list && list.length === 0 ? (
        tab === 'pending' ? (
          <EmptyState icon="checkCircle" title={t.queueEmpty} text={t.queueEmptyText} />
        ) : (
          <EmptyState icon="inbox" title={t.recentEmpty} />
        )
      ) : null}

      <div className="cards">
        {(list ?? []).map((card) => {
          const stale = tab === 'pending' && isStale(card, alertHours);
          return (
            <article key={card.id} className={`card queue-card${stale ? ' queue-card-stale' : ''}`}>
              <div className="queue-card-head">
                <Initials name={card.customerName} />
                <div className="queue-card-who">
                  <h3 className="item-title">{card.customerName}</h3>
                  <a className="muted small" href={`tel:${card.phone}`}>
                    {formatPhoneForDisplay(card.phone)}
                  </a>
                </div>
                <div className="queue-card-amount">
                  <strong className="amount amount-lg">{formatInr(card.totalPaise)}</strong>
                  <span className="muted small">
                    {t.spareShort} {formatInr(card.spareCostPaise)}
                  </span>
                </div>
              </div>

              <ul className="meta">
                <li>
                  <Icon name="wrench" size={16} />
                  <span>
                    {card.appliance}
                    {card.brand ? ` · ${card.brand}` : ''} · {card.serviceDescription}
                  </span>
                </li>
                {card.area ? (
                  <li>
                    <Icon name="pin" size={16} />
                    <span>{card.area}</span>
                  </li>
                ) : null}
                <li>
                  <Icon name="clock" size={16} />
                  <span>
                    {tab === 'recent' && card.copiedByName && card.copiedAt
                      ? t.copiedBy(card.copiedByName, timeIst(card.copiedAt))
                      : `${ageLabel(card.submittedAt)} · ${t.byTechnician(card.technicianName)}`}
                  </span>
                </li>
              </ul>

              <div className="pills">
                {stale ? (
                  <span className="pill pill-bad">
                    <Icon name="clock" size={14} />
                    {ageLabel(card.submittedAt)}
                  </span>
                ) : null}
                {card.requeued && card.invoiceNumber ? <span className="pill pill-issued">{t.requeued(card.invoiceNumber)}</span> : null}
                {tab === 'recent' && card.invoiceNumber ? (
                  <span className="pill pill-issued">{formatInvoiceNumber(card.invoiceNumber)}</span>
                ) : null}
                {card.possibleDuplicate ? <span className="pill pill-warn">{t.possibleDuplicate}</span> : null}
                {card.negativeMargin ? <span className="pill pill-bad">{t.negativeMargin}</span> : null}
                {card.edited ? <span className="pill pill-muted">{t.edited}</span> : null}
              </div>

              <details className="preview">
                <summary>{t.preview}</summary>
                <pre className="message-preview">{card.preview}</pre>
              </details>

              {tab === 'pending' ? (
                <div className="queue-actions">
                  <PhoneThenInvoice
                    stepKey={card.id}
                    phone={card.phone}
                    invoiceLabel={t.copyInvoice}
                    onCopyInvoice={() => copy(card)}
                    disabled={busyId === card.id}
                    large
                  />
                  {card.state === 'submitted' ? (
                    <div className="row">
                      {can('invoice.edit_pending') ? (
                        <button type="button" className="btn btn-ghost grow" onClick={() => setEditing(card)}>
                          <Icon name="edit" size={18} />
                          {t.edit}
                        </button>
                      ) : null}
                      {can('invoice.reject') ? (
                        <button type="button" className="btn btn-ghost btn-danger grow" onClick={() => setRejecting(card)}>
                          <Icon name="x" size={18} />
                          {t.reject}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="queue-actions">
                  <PhoneThenInvoice
                    stepKey={card.id}
                    phone={card.phone}
                    invoiceLabel={t.copyAgain}
                    onCopyInvoice={() => copy(card)}
                    disabled={busyId === card.id}
                  />
                  <button type="button" className="btn btn-ghost btn-block" disabled={busyId === card.id} onClick={() => void putBack(card)}>
                    <Icon name="undo" size={18} />
                    {t.putBack}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {editing ? (
        <EditDialog
          card={editing}
          onClose={(changed) => {
            setEditing(null);
            if (changed) {
              poll();
              void load(false);
            }
          }}
        />
      ) : null}
      {rejecting ? (
        <RejectDialog
          card={rejecting}
          onClose={(done) => {
            setRejecting(null);
            if (done) {
              setPending((items) => items?.filter((i) => i.id !== rejecting.id) ?? null);
              poll();
              void load(false);
            }
          }}
        />
      ) : null}
    </section>
  );
}

function isStale(card: QueueCard, alertHours: number): boolean {
  return Date.now() - Date.parse(card.submittedAt) > alertHours * 3_600_000;
}

function RejectDialog({ card, onClose }: { card: QueueCard; onClose: (done: boolean) => void }) {
  const { toast } = useFeedback();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/api/workinv/${card.id}/reject`, { method: 'POST', body: { reason: reason.trim() } });
      onClose(true);
    } catch {
      toast({ text: t.somethingWrong, tone: 'error' });
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.rejectTitle} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <p>
          <strong>{card.customerName}</strong> · {formatInr(card.totalPaise)}
        </p>
        <Field label={t.rejectReason}>
          <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
        </Field>
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onClose(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn-danger-solid grow" disabled={busy || reason.trim().length < 3}>
            {t.reject}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function EditDialog({ card, onClose }: { card: QueueCard; onClose: (changed: boolean) => void }) {
  const lookups = useLookups();
  const { toast, withStepUp } = useFeedback();
  const [form, setForm] = useState({
    customerName: card.customerName,
    phone: card.phone.replace(/^\+91/, ''),
    area: card.area ?? '',
    applianceTypeKey: card.applianceTypeKey,
    brand: card.brand ?? '',
    serviceDescription: card.serviceDescription,
    total: String(card.totalPaise / 100),
    spare: String(card.spareCostPaise / 100),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!lookups) return null;
  const set = (key: keyof typeof form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const changes: Record<string, unknown> = {};
    const phone = normalizeIndianMobile(form.phone);
    if (!phone) return setError(t.invalidPhone);
    const area = form.area.trim() ? lookups!.areas.find((a) => a.name.toLowerCase() === form.area.trim().toLowerCase()) : null;
    const brand = form.brand.trim() ? lookups!.brands.find((b) => b.name.toLowerCase() === form.brand.trim().toLowerCase()) : null;
    if (area === undefined || brand === undefined) return setError(t.chooseFromList);
    const total = Number(form.total);
    const spare = Number(form.spare || '0');
    if (!Number.isInteger(total) || total < 1 || !Number.isInteger(spare) || spare < 0) return setError(t.wholeRupees);

    if (form.customerName.trim() !== card.customerName) changes.customerName = form.customerName.trim();
    if (phone !== card.phone) changes.phone = phone;
    if ((area?.id ?? null) !== card.areaId) changes.areaId = area?.id ?? null;
    if (form.applianceTypeKey !== card.applianceTypeKey) changes.applianceTypeKey = form.applianceTypeKey;
    if ((brand?.id ?? null) !== card.brandId) changes.brandId = brand?.id ?? null;
    if (form.serviceDescription.trim() !== card.serviceDescription) changes.serviceDescription = form.serviceDescription.trim();
    if (total * 100 !== card.totalPaise) changes.totalRupees = total;
    if (spare * 100 !== card.spareCostPaise) changes.spareCostRupees = spare;
    if (Object.keys(changes).length === 0) return onClose(false);

    setBusy(true);
    setError(null);
    try {
      await withStepUp(() => api(`/api/workinv/${card.id}`, { method: 'PATCH', body: changes }));
      toast({ text: t.edited, tone: 'ok' });
      onClose(true);
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setError(err instanceof ApiError && err.code === 'wrong_state' ? t.notCopyable : t.somethingWrong);
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.editTitle} onClose={() => onClose(false)} wide>
      <form className="stack" onSubmit={submit}>
        <Field label={t.customerName} icon="user">
          <input value={form.customerName} onChange={(e) => set('customerName')(e.target.value)} />
        </Field>
        <Field label={t.phone} icon="phone">
          <input type="tel" inputMode="tel" value={form.phone} onChange={(e) => set('phone')(e.target.value)} />
        </Field>
        <Combobox label={t.area} icon="pin" value={form.area} options={lookups.areas.map((a) => a.name)} onChange={set('area')} />
        <Chips
          label={t.appliance}
          options={lookups.applianceTypes.map((a) => ({ value: a.key, label: a.label }))}
          value={form.applianceTypeKey}
          onChange={set('applianceTypeKey')}
        />
        <Combobox label={t.brand} value={form.brand} options={lookups.brands.map((b) => b.name)} onChange={set('brand')} />
        <Field label={t.serviceDescription}>
          <textarea rows={2} value={form.serviceDescription} onChange={(e) => set('serviceDescription')(e.target.value)} />
        </Field>
        <div className="two-col">
          <MoneyInput label={t.total} value={form.total} onChange={set('total')} hint={t.amountNeedsPin} />
          <MoneyInput label={t.spareCost} value={form.spare} onChange={set('spare')} />
        </div>
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
