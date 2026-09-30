import { useCallback, useEffect, useState } from 'react';
import type { MySubmission } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { useUser } from '../app/session.tsx';
import { Icon } from '../components/Icon.tsx';
import { EmptyState, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api } from '../lib/api.ts';
import { dateTimeIst, formatInr, rupeesLabel } from '../lib/format.ts';
import { outbox } from '../lib/outbox-idb.ts';
import type { OutboxItem } from '../lib/outbox.ts';

/** Technician's own jobs: "Not yet on server", Submitted, Issued (number), Rejected (reason). */
export function MySubmissions({ offline }: { offline: boolean }) {
  const user = useUser();
  const [items, setItems] = useState<MySubmission[] | null>(null);
  const [queued, setQueued] = useState<OutboxItem[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const loadQueued = useCallback(() => {
    void outbox.items(user.user.id).then(setQueued);
  }, [user.user.id]);

  const load = useCallback(async () => {
    loadQueued();
    if (offline) return;
    setRefreshing(true);
    try {
      const res = await api<{ items: MySubmission[] }>('/api/jobs/mine');
      setItems(res.items);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setRefreshing(false);
    }
  }, [offline, loadQueued]);

  useEffect(() => {
    void load();
    // When the outbox sends (or fails) a job, reload both lists so a sent job moves from
    // "Not yet on server" to its server status instead of seeming to vanish.
    const off = outbox.subscribe(() => void load());
    // Coming back to the app (e.g. after WhatsApp) or back online always reloads from the server.
    const onVisible = () => document.visibilityState === 'visible' && void load();
    const onOnline = () => void load();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [load]);

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t.navMySubmissions}</h2>
        </div>
        <button type="button" className="icon-btn" aria-label={t.refresh} onClick={() => void load()} disabled={offline || refreshing}>
          <Icon name="refresh" className={refreshing ? 'spin' : undefined} />
        </button>
      </header>

      <div className="list">
        {queued.map((q) => (
          <article key={q.key} className={`card job-card status-${q.status === 'failed' ? 'rejected' : 'queued'}`}>
            <div className="job-card-top">
              <strong className="job-card-name">{q.summary.customerName}</strong>
              <strong className="amount">{rupeesLabel(q.summary.totalRupees)}</strong>
            </div>
            <div className="muted small">{q.summary.applianceLabel}</div>
            <div className="job-card-foot">
              <span className={`pill ${q.status === 'failed' ? 'pill-bad' : 'pill-muted'}`}>
                <Icon name={q.status === 'failed' ? 'alert' : 'wifiOff'} size={14} />
                {q.status === 'failed' ? t.needsFixing : t.notYetOnServer}
              </span>
              {q.status === 'failed' ? (
                <button type="button" className="btn btn-small btn-ghost" onClick={() => void outbox.discard(q.key)}>
                  {t.discard}
                </button>
              ) : null}
            </div>
          </article>
        ))}

        {items === null && !offline && !loadError ? <Skeleton lines={6} /> : null}
        {loadError ? (
          <p className="form-error">
            <Icon name="wifiOff" size={18} /> <span>{t.serverUnreachable}</span>
          </p>
        ) : null}
        {items && items.length === 0 && queued.length === 0 ? (
          <EmptyState icon="list" title={t.noSubmissions} text={t.noSubmissionsText} />
        ) : null}

        {(items ?? []).map((s) => (
          <article key={s.id} className={`card job-card status-${s.state}`}>
            <div className="job-card-top">
              <strong className="job-card-name">{s.customerName}</strong>
              <strong className="amount">{formatInr(s.totalPaise)}</strong>
            </div>
            <div className="muted small">
              {s.appliance}
              {s.brand ? ` · ${s.brand}` : ''} · {s.serviceDescription}
            </div>
            <div className="muted small">
              {t.spareShort} {formatInr(s.spareCostPaise)} · {dateTimeIst(s.submittedAt)}
            </div>
            <div className="job-card-foot">
              <span className={`pill pill-${s.state}`}>
                <Icon
                  name={s.state === 'issued' ? 'checkCircle' : s.state === 'rejected' ? 'alert' : s.state === 'void' ? 'ban' : 'clock'}
                  size={14}
                />
                {s.state === 'issued' || s.state === 'void'
                  ? `${t.stateLabel[s.state]} · ${formatInvoiceNumber(s.invoiceNumber!)}`
                  : t.stateLabel[s.state]}
              </span>
              {s.warrantyService ? <span className="pill pill-gold">{t.warrantyService}</span> : null}
              {s.editedByOffice ? (
                <span className="pill pill-muted">
                  <Icon name="edit" size={14} />
                  {t.editedByOffice}
                </span>
              ) : null}
            </div>
            {s.state === 'rejected' && s.rejectedReason ? <p className="reject-note">{t.rejectedBecause(s.rejectedReason)}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}
