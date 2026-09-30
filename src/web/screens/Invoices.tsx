import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { CopyResponse, InvoiceDetail, InvoiceRow, InvoiceState, VoidRequestRow } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { StepUpCancelled, useFeedback } from '../app/feedback.tsx';
import { useQueue } from '../app/queue.tsx';
import { useSession } from '../app/session.tsx';
import { PhoneThenInvoice } from '../components/CopyPhoneFirst.tsx';
import { Icon } from '../components/Icon.tsx';
import { Dialog, EmptyState, Field, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError } from '../lib/api.ts';
import { copyWhenReady } from '../lib/clipboard.ts';
import { istDateString } from '../../shared/dates.ts';
import { dateTimeIst, formatDateDmy, formatInr, formatPhoneForDisplay } from '../lib/format.ts';

const STATES: Array<InvoiceState | ''> = ['', 'submitted', 'issued', 'rejected', 'void'];

type DateFilter = 'all' | 'today' | 'yesterday' | 'range';

const DATE_FILTERS: Array<{ key: DateFilter; label: string }> = [
  { key: 'all', label: t.dateAll },
  { key: 'today', label: t.rangeToday },
  { key: 'yesterday', label: t.dateYesterday },
  { key: 'range', label: t.dateRangeCustom },
];

/** Invoice-date bounds (IST calendar dates) for the date filter; 'invalid' if From is after To. */
export function dateBounds(
  filter: DateFilter,
  from: string,
  to: string,
  today: string,
): { from?: string; to?: string } | 'invalid' {
  if (filter === 'today') return { from: today, to: today };
  if (filter === 'yesterday') {
    const y = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    return { from: y, to: y };
  }
  if (filter === 'range') {
    if (from && to && from > to) return 'invalid';
    return { from: from || undefined, to: to || undefined };
  }
  return {};
}

function StatePill({ row }: { row: Pick<InvoiceRow, 'state' | 'invoiceNumber'> }) {
  return (
    <span className={`pill pill-${row.state}`}>
      {row.invoiceNumber ? formatInvoiceNumber(row.invoiceNumber) : t.stateLabel[row.state]}
    </span>
  );
}

/** All invoices, newest first, server-side search and pagination. Checkers and the Master. */
export function Invoices({ initialQuery = '' }: { initialQuery?: string }) {
  const { can } = useSession();
  const [q, setQ] = useState(initialQuery);
  const [state, setState] = useState<InvoiceState | ''>('');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [items, setItems] = useState<InvoiceRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const showProfit = can('profit.view');
  const today = istDateString();
  const bounds = dateBounds(dateFilter, rangeFrom, rangeTo, today);

  const fetchPage = useCallback(
    async (after: string | null) => {
      if (bounds === 'invalid') return;
      const params = new URLSearchParams({ limit: '30' });
      if (q.trim()) params.set('q', q.trim());
      if (state) params.set('state', state);
      if (bounds.from) params.set('from', bounds.from);
      if (bounds.to) params.set('to', bounds.to);
      if (after) params.set('cursor', after);
      const res = await api<{ items: InvoiceRow[]; nextCursor: string | null }>(`/api/invoices?${params}`);
      setItems((prev) => (after && prev ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
    },
    [q, state, bounds === 'invalid' ? 'invalid' : `${bounds.from ?? ''}|${bounds.to ?? ''}`], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    const id = window.setTimeout(() => void fetchPage(null).catch(() => setItems([])), 250);
    return () => window.clearTimeout(id);
  }, [fetchPage]);

  // "/" focuses search (desktop keyboard shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !document.getElementById('top-search') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="page">
      <header className="page-head">
        <h2 className="page-title">{t.navInvoices}</h2>
      </header>

      <div className="search">
        <Icon name="search" size={18} className="search-icon" />
        <input
          ref={searchRef}
          type="search"
          placeholder={t.search}
          aria-label={t.search}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="chips chips-small filter-chips" role="radiogroup" aria-label={t.allStates}>
        {STATES.map((s) => (
          <button
            key={s || 'all'}
            type="button"
            role="radio"
            aria-checked={state === s}
            className={`chip${state === s ? ' chip-on' : ''}`}
            onClick={() => setState(s)}
          >
            {s ? t.stateLabel[s] : t.allStates}
          </button>
        ))}
      </div>
      <div className="chips chips-small filter-chips" role="radiogroup" aria-label={t.filterDate}>
        {DATE_FILTERS.map((d) => (
          <button
            key={d.key}
            type="button"
            role="radio"
            aria-checked={dateFilter === d.key}
            className={`chip${dateFilter === d.key ? ' chip-on' : ''}`}
            onClick={() => setDateFilter(d.key)}
          >
            {d.key === 'range' ? <Icon name="clock" size={14} /> : null}
            {d.label}
          </button>
        ))}
      </div>
      {dateFilter === 'range' ? (
        <div className="date-range">
          <Field label={t.dateFrom}>
            <input type="date" max={rangeTo || today} value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
          </Field>
          <Field label={t.dateTo}>
            <input type="date" min={rangeFrom || undefined} max={today} value={rangeTo} onChange={(e) => setRangeTo(e.target.value)} />
          </Field>
        </div>
      ) : null}
      {bounds === 'invalid' ? (
        <p className="form-error">
          <Icon name="alert" size={18} /> <span>{t.dateRangeInvalid}</span>
        </p>
      ) : null}

      {items === null ? <Skeleton lines={8} /> : null}
      {items && items.length === 0 ? <EmptyState icon="search" title={t.noInvoices} text={t.noInvoicesText} /> : null}

      {items && items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t.invoice}</th>
                <th>{t.date}</th>
                <th>{t.customer}</th>
                <th>{t.technician}</th>
                <th className="num">{t.total}</th>
                <th className="num">{t.spareCost}</th>
                {showProfit ? <th className="num">{t.grossProfit}</th> : null}
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id} onClick={() => setOpenId(row.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpenId(row.id)}>
                  <td data-label={t.invoice}>
                    <StatePill row={row} />
                  </td>
                  <td data-label={t.date}>{formatDateDmy(row.invoiceDate)}</td>
                  <td data-label={t.customer}>
                    <strong>{row.customerName}</strong>
                    <div className="muted small">{row.appliance}</div>
                  </td>
                  <td data-label={t.technician}>{row.technicianName}</td>
                  <td data-label={t.total} className="num strong">
                    {formatInr(row.totalPaise)}
                  </td>
                  <td data-label={t.spareCost} className="num">
                    {formatInr(row.spareCostPaise)}
                  </td>
                  {showProfit ? (
                    <td data-label={t.grossProfit} className={`num ${row.grossProfitPaise < 0 ? 'neg' : 'pos'}`}>
                      {formatInr(row.grossProfitPaise)}
                    </td>
                  ) : null}
                  <td className="flags">
                    {row.selfIssued ? <span className="pill pill-muted">{t.selfIssued}</span> : null}
                    {row.voidRequestPending ? <span className="pill pill-warn">{t.voidRequested}</span> : null}
                    {row.edited ? <span className="pill pill-muted">{t.edited}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {cursor ? (
        <button type="button" className="btn btn-ghost" onClick={() => void fetchPage(cursor)}>
          {t.loadMore}
        </button>
      ) : null}

      {openId ? (
        <InvoiceDialog
          id={openId}
          onClose={(changed) => {
            setOpenId(null);
            if (changed) void fetchPage(null);
          }}
        />
      ) : null}
    </section>
  );
}

function InvoiceDialog({ id, onClose }: { id: string; onClose: (changed: boolean) => void }) {
  const { can } = useSession();
  const { toast, withStepUp, showCopyFallback } = useFeedback();
  const { poll } = useQueue();
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [voidMode, setVoidMode] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InvoiceDetail>(`/api/invoices/${id}`)
      .then(setDetail)
      .catch(() => onClose(false));
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!detail) {
    return (
      <Dialog title={t.invoice} onClose={() => onClose(false)} wide>
        <Skeleton lines={8} />
      </Dialog>
    );
  }

  const canVoid = can('invoice.void');
  const canRequest = can('void.request') && !canVoid;

  /** The second tap (after Copy phone): copies the stored message again. */
  function copyAgain(): Promise<boolean> {
    const request = api<CopyResponse>(`/api/workinv/${id}/copy`, { method: 'POST', body: { expect: 'issued' } });
    const copied = copyWhenReady(request.then((r) => r.message));
    return request
      .then(async (r) => {
        if (!(await copied)) showCopyFallback(r.message);
        toast({ text: t.copiedFor(formatInvoiceNumber(r.invoiceNumber), r.customerName), tone: 'ok' });
        poll();
        return true;
      })
      .catch(() => {
        toast({ text: t.somethingWrong, tone: 'error' });
        return false;
      });
  }

  async function submitVoid(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (canVoid) {
        await withStepUp(() => api(`/api/invoices/${id}/void`, { method: 'POST', body: { reason: reason.trim() } }));
      } else {
        await api(`/api/invoices/${id}/void-request`, { method: 'POST', body: { reason: reason.trim() } });
        toast({ text: t.voidRequestSent, tone: 'ok' });
      }
      poll();
      onClose(true);
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) {
        toast({ text: err instanceof ApiError && err.code === 'already_requested' ? t.voidRequested : t.somethingWrong, tone: 'error' });
      }
      setBusy(false);
    }
  }

  const title = detail.invoiceNumber ? formatInvoiceNumber(detail.invoiceNumber) : t.stateLabel[detail.state]!;
  return (
    <Dialog title={title} onClose={() => onClose(false)} wide>
      <div className="stack">
        <div className="pills">
          <span className={`pill pill-${detail.state}`}>{t.stateLabel[detail.state]}</span>
          {detail.selfIssued ? <span className="pill pill-muted">{t.selfIssued}</span> : null}
          {detail.voidRequestPending ? <span className="pill pill-warn">{t.voidRequested}</span> : null}
          <span className="pill pill-muted">{t.warrantyUntil(formatDateDmy(detail.warrantyExpiresAt))}</span>
        </div>

        <div className="money-strip">
          <div>
            <span className="muted small">{t.total}</span>
            <strong className="amount amount-lg">{formatInr(detail.totalPaise)}</strong>
          </div>
          <div>
            <span className="muted small">{t.spareCost}</span>
            <strong className="amount">{formatInr(detail.spareCostPaise)}</strong>
          </div>
          <div>
            <span className="muted small">{t.grossProfit}</span>
            <strong className={`amount ${detail.grossProfitPaise < 0 ? 'neg' : 'pos'}`}>{formatInr(detail.grossProfitPaise)}</strong>
          </div>
        </div>

        <ul className="meta">
          <li>
            <Icon name="user" size={16} />
            <span>
              {detail.customerName} · {formatPhoneForDisplay(detail.phone)}
              {detail.area ? ` · ${detail.area}` : ''}
            </span>
          </li>
          <li>
            <Icon name="wrench" size={16} />
            <span>
              {detail.appliance}
              {detail.brand ? ` · ${detail.brand}` : ''} · {detail.serviceDescription}
            </span>
          </li>
          <li>
            <Icon name="clock" size={16} />
            <span>
              {detail.technicianName} · {dateTimeIst(detail.submittedAt)}
            </span>
          </li>
          {detail.rejectedReason ? (
            <li>
              <Icon name="alert" size={16} />
              <span>{t.rejectedBecause(detail.rejectedReason)}</span>
            </li>
          ) : null}
          {detail.voidReason ? (
            <li>
              <Icon name="ban" size={16} />
              <span>{detail.voidReason}</span>
            </li>
          ) : null}
        </ul>

        {detail.message ? <pre className="message-preview">{detail.message}</pre> : null}

        {detail.state === 'issued' ? (
          <div className="stack-sm">
            <PhoneThenInvoice stepKey={detail.id} phone={detail.phone} invoiceLabel={t.copyAgain} onCopyInvoice={copyAgain} />
            {(canVoid || (canRequest && !detail.voidRequestPending)) && !voidMode ? (
              <button type="button" className="btn btn-ghost btn-danger btn-block" onClick={() => setVoidMode(true)}>
                <Icon name="ban" size={18} />
                {canVoid ? t.voidInvoice : t.requestVoid}
              </button>
            ) : null}
          </div>
        ) : null}

        {voidMode ? (
          <form className="stack" onSubmit={submitVoid}>
            <Field label={t.voidReason}>
              <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
            </Field>
            <button type="submit" className="btn btn-danger-solid" disabled={busy || reason.trim().length < 3}>
              {canVoid ? t.voidInvoice : t.requestVoid}
            </button>
          </form>
        ) : null}

        <details className="preview">
          <summary>{t.history}</summary>
          <ul className="history">
            {detail.history.map((h, i) => (
              <li key={i}>
                <span className="muted small">{dateTimeIst(h.at)}</span> {h.action}
                {h.actorName ? ` · ${h.actorName}` : ''}
                {h.reason ? ` · ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Dialog>
  );
}

/** Master: pending void requests from the Admin Technician. */
export function VoidRequests() {
  const { toast, withStepUp } = useFeedback();
  const { poll } = useQueue();
  const [items, setItems] = useState<VoidRequestRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ items: VoidRequestRow[] }>('/api/void-requests?status=pending')
      .then((res) => setItems(res.items))
      .catch(() => setItems([]));
  }, []);

  useEffect(load, [load]);

  async function decide(row: VoidRequestRow, approve: boolean) {
    setBusy(row.id);
    try {
      if (approve) {
        await withStepUp(() => api(`/api/void-requests/${row.id}/approve`, { method: 'POST', body: {} }));
      } else {
        await api(`/api/void-requests/${row.id}/reject`, { method: 'POST', body: {} });
      }
      poll();
      load();
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) toast({ text: t.somethingWrong, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <h2 className="page-title">{t.navVoidRequests}</h2>
      </header>
      {items === null ? <Skeleton lines={4} /> : null}
      {items && items.length === 0 ? <EmptyState icon="ban" title={t.noVoidRequests} text={t.noVoidRequestsText} /> : null}
      <div className="cards">
        {(items ?? []).map((row) => (
          <article key={row.id} className="card queue-card">
            <div className="queue-card-head">
              <span className="pill pill-issued">{formatInvoiceNumber(row.invoiceNumber)}</span>
              <div className="queue-card-who">
                <h3 className="item-title">{row.customerName}</h3>
              </div>
              <strong className="amount amount-lg">{formatInr(row.totalPaise)}</strong>
            </div>
            <p className="quote">{row.reason}</p>
            <p className="muted small">
              {t.requestedBy(row.requestedByName)} · {dateTimeIst(row.createdAt)}
            </p>
            <div className="row">
              <button type="button" className="btn btn-ghost grow" disabled={busy === row.id} onClick={() => void decide(row, false)}>
                {t.refuse}
              </button>
              <button type="button" className="btn btn-danger-solid grow" disabled={busy === row.id} onClick={() => void decide(row, true)}>
                {t.approve}
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
