import { useCallback, useEffect, useState } from 'react';
import type { WorkOrder } from '../../shared/api-types.ts';
import { useFeedback } from '../app/feedback.tsx';
import { useUser } from '../app/session.tsx';
import { isOpenWork, useWork } from '../app/work.tsx';
import { Icon } from '../components/Icon.tsx';
import { WorkCard } from '../components/WorkCard.tsx';
import { EmptyState, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { outbox } from '../lib/outbox-idb.ts';
import { JobForm } from './JobForm.tsx';

/**
 * Works assigned (Invoice + Work allocation technicians): the jobs the office assigned,
 * soonest visit first. Start a job, then "Complete & create invoice" opens the job form
 * pre-filled with the customer; the invoice then goes to Work Inv like any other job.
 */
export function WorksAssigned() {
  const user = useUser();
  const { items, fromCache, reload, update } = useWork();
  const { toast } = useFeedback();
  const [completing, setCompleting] = useState<WorkOrder | null>(null);
  const [queuedJobs, setQueuedJobs] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadQueued = useCallback(() => {
    void outbox.items(user.user.id).then((all) => setQueuedJobs(new Set(all.flatMap((i) => (i.workJobId ? [i.workJobId] : [])))));
  }, [user.user.id]);

  useEffect(() => {
    loadQueued();
    // When a queued completion reaches the server, show the job's new status.
    return outbox.subscribe(() => {
      loadQueued();
      void reload();
    });
  }, [loadQueued, reload]);

  async function refresh() {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }

  async function start(work: WorkOrder) {
    setBusyId(work.id);
    try {
      await api(`/api/work/${work.id}/start`, { method: 'POST' });
      update(work.id, { status: 'in_progress', startedAt: new Date().toISOString() });
      toast({ text: t.workStarted, tone: 'ok' });
    } catch (err) {
      const text = isNetworkError(err)
        ? t.offlineAction
        : err instanceof ApiError && (err.code === 'not_found' || err.code === 'wrong_state')
          ? t.workGone
          : t.somethingWrong;
      toast({ text, tone: 'error' });
    } finally {
      setBusyId(null);
      void reload();
    }
  }

  if (completing) {
    return (
      <section className="page">
        <header className="page-head">
          <div>
            <h2 className="page-title">{t.completeTitle}</h2>
            <p className="page-sub">{t.completeIntro}</p>
          </div>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setCompleting(null)}>
            {t.back}
          </button>
        </header>
        <JobForm
          mode="submit"
          work={completing}
          onDone={() => {
            setCompleting(null);
            loadQueued();
            void reload();
          }}
        />
      </section>
    );
  }

  const open = (items ?? []).filter(isOpenWork);
  const done = (items ?? []).filter((w) => !isOpenWork(w));

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t.navWorksAssigned}</h2>
          <p className="page-sub">{t.worksIntro}</p>
        </div>
        <button type="button" className="icon-btn" aria-label={t.refresh} onClick={() => void refresh()} disabled={refreshing}>
          <Icon name="refresh" className={refreshing ? 'spin' : undefined} />
        </button>
      </header>

      {fromCache ? (
        <p className="banner banner-warn" role="status">
          <Icon name="wifiOff" size={18} /> {t.workFromCache}
        </p>
      ) : null}
      {items === null ? <Skeleton lines={6} /> : null}
      {items && open.length === 0 ? <EmptyState icon="clipboard" title={t.worksEmpty} text={t.worksEmptyText} /> : null}

      {open.length > 0 ? <h3 className="list-heading">{t.worksToDo}</h3> : null}
      <div className="cards">
        {open.map((work) => (
          <WorkCard key={work.id} work={work}>
            {queuedJobs.has(work.id) ? (
              <span className="pill pill-muted">
                <Icon name="wifiOff" size={14} />
                {t.notYetOnServer}
              </span>
            ) : (
              <div className="queue-actions">
                <button type="button" className="btn btn-primary btn-large btn-block" onClick={() => setCompleting(work)}>
                  <Icon name="checkCircle" />
                  {t.completeWork}
                </button>
                <div className="row">
                  <a className="btn btn-ghost grow" href={`tel:${work.phone}`}>
                    <Icon name="phone" size={18} />
                    {t.callCustomer}
                  </a>
                  {work.status === 'assigned' ? (
                    <button type="button" className="btn btn-ghost grow" disabled={busyId === work.id} onClick={() => void start(work)}>
                      <Icon name="play" size={18} />
                      {t.startWork}
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </WorkCard>
        ))}
      </div>

      {done.length > 0 ? <h3 className="list-heading">{t.worksDone}</h3> : null}
      <div className="cards">
        {done.map((work) => (
          <WorkCard key={work.id} work={work} />
        ))}
      </div>
    </section>
  );
}
