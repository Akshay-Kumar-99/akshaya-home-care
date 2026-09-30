import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { useQueue } from '../app/queue.tsx';
import { useSession, useUser } from '../app/session.tsx';
import { useWork, WorkProvider } from '../app/work.tsx';
import { Icon, Logo, type IconName } from '../components/Icon.tsx';
import { Skeleton, ThemeToggle } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { outbox } from '../lib/outbox-idb.ts';
import { navigate, usePath } from '../lib/router.ts';
import { JobForm } from '../screens/JobForm.tsx';
import { MySubmissions } from '../screens/MySubmissions.tsx';

// Screens not every user needs load on demand: Invoice-only technicians never download the
// Works assigned screen, and technicians never download the checker screens.
const WorkInv = lazy(() => import('../screens/WorkInv.tsx').then((m) => ({ default: m.WorkInv })));
const Invoices = lazy(() => import('../screens/Invoices.tsx').then((m) => ({ default: m.Invoices })));
const WorkOrders = lazy(() => import('../screens/WorkOrders.tsx').then((m) => ({ default: m.WorkOrders })));
const WorksAssigned = lazy(() => import('../screens/WorksAssigned.tsx').then((m) => ({ default: m.WorksAssigned })));

interface Tab {
  path: string;
  label: string;
  icon: IconName;
  badge?: number;
}

const TECHNICIAN_TABS: Tab[] = [
  { path: '/new-job', label: t.navNewJob, icon: 'plus' },
  { path: '/my-submissions', label: t.navMySubmissionsShort, icon: 'list' },
];

function useCheckerTabs(): Tab[] {
  const { snapshot } = useQueue();
  const { can } = useSession();
  return [
    { path: '/work-inv', label: t.navWorkInvShort, icon: 'inbox', badge: snapshot?.pendingCount },
    ...(can('work.assign') ? [{ path: '/work-orders', label: t.navWorkOrders, icon: 'clipboard' as const }] : []),
    { path: '/new-invoice', label: t.navNewInvoice, icon: 'plus' },
    { path: '/invoices', label: t.navInvoicesShort, icon: 'receipt' },
  ];
}

/** Phones (technicians, Admin Technician): bottom tab bar, one-handed, thumb-zone actions. */
export default function MobileShell({ offline }: { offline: boolean }) {
  const info = useUser();
  return info.user.role === 'technician' ? <TechnicianShell offline={offline} /> : <CheckerMobileShell />;
}

function TechnicianShell({ offline }: { offline: boolean }) {
  const info = useUser();

  // Keep sending queued jobs: on start, when back online, on return to the app, and every 30 s.
  useEffect(() => {
    const flush = () => void outbox.flush(info.user.id);
    flush();
    const id = window.setInterval(flush, 30_000);
    const onVisible = () => document.visibilityState === 'visible' && flush();
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [info.user.id]);

  // "Invoice + Work allocation" technicians also get the Works assigned tab (first).
  if (info.permissions.includes('work.do')) {
    return (
      <WorkProvider userId={info.user.id}>
        <WorkTechnicianTabs offline={offline} />
      </WorkProvider>
    );
  }
  return <TechnicianTabs tabs={TECHNICIAN_TABS} offline={offline} />;
}

function WorkTechnicianTabs({ offline }: { offline: boolean }) {
  const { openCount } = useWork();
  const tabs: Tab[] = [{ path: '/works', label: t.navWorksAssigned, icon: 'clipboard', badge: openCount }, ...TECHNICIAN_TABS];
  return <TechnicianTabs tabs={tabs} offline={offline} />;
}

function TechnicianTabs({ tabs, offline }: { tabs: Tab[]; offline: boolean }) {
  const path = usePath();
  const current = tabs.some((tab) => tab.path === path) ? path : tabs[0]!.path;
  useEffect(() => {
    if (current !== path) navigate(current, true);
  }, [current, path]);

  return (
    <Frame tabs={tabs} current={current} offline={offline}>
      {current === '/works' ? (
        <Suspense fallback={<Skeleton lines={8} />}>
          <WorksAssigned />
        </Suspense>
      ) : null}
      {current === '/new-job' ? (
        <section className="page">
          <header className="page-head">
            <div>
              <h2 className="page-title">{t.navNewJob}</h2>
              <p className="page-sub">{t.newJobIntro}</p>
            </div>
          </header>
          <JobForm mode="submit" />
        </section>
      ) : null}
      {current === '/my-submissions' ? <MySubmissions offline={offline} /> : null}
    </Frame>
  );
}

function CheckerMobileShell() {
  const path = usePath();
  const tabs = useCheckerTabs();
  const current = tabs.some((tab) => tab.path === path) ? path : '/work-inv';
  useEffect(() => {
    if (current !== path) navigate(current, true);
  }, [current, path]);

  return (
    <Frame tabs={tabs} current={current} offline={false}>
      <Suspense fallback={<Skeleton lines={8} />}>
        {current === '/work-inv' ? <WorkInv /> : null}
        {current === '/work-orders' ? <WorkOrders /> : null}
        {current === '/new-invoice' ? (
          <section className="page">
            <header className="page-head">
              <div>
                <h2 className="page-title">{t.navNewInvoice}</h2>
                <p className="page-sub">{t.newInvoiceIntro}</p>
              </div>
            </header>
            <JobForm mode="copy" />
          </section>
        ) : null}
        {current === '/invoices' ? <Invoices /> : null}
      </Suspense>
    </Frame>
  );
}

function Frame(props: { tabs: Tab[]; current: string; offline: boolean; children: ReactNode }) {
  const info = useUser();
  const { logout } = useSession();
  const label = info.user.technicianMode === 'invoice_and_work' ? t.technicianMode.invoice_and_work : t.roleLabel[info.user.role];
  return (
    <div className="mobile-shell">
      <header className="appbar">
        <div className="appbar-brand">
          <Logo size={40} />
          <div className="appbar-text">
            <strong>{t.appShort}</strong>
            <span className="appbar-user">
              {info.user.displayName}
              {info.user.displayName !== label ? ` · ${label}` : ''}
            </span>
          </div>
        </div>
        <div className="appbar-actions">
          <ThemeToggle />
          <button type="button" className="icon-btn" aria-label={t.signOut} title={t.signOut} onClick={() => void logout()}>
            <Icon name="logout" />
          </button>
        </div>
      </header>
      {props.offline ? (
        <p className="banner banner-warn offline-banner">
          <Icon name="wifiOff" size={18} /> {t.offlineBanner}
        </p>
      ) : null}
      <main className="mobile-content">{props.children}</main>
      <nav className="tabbar" aria-label="Main">
        {props.tabs.map((tab) => (
          <button
            key={tab.path}
            type="button"
            className={`tabbar-item${tab.path === props.current ? ' tabbar-item-on' : ''}`}
            aria-current={tab.path === props.current ? 'page' : undefined}
            onClick={() => navigate(tab.path)}
          >
            <span className="tabbar-icon">
              <Icon name={tab.icon} size={22} />
              {tab.badge ? <span className="tabbar-badge">{tab.badge}</span> : null}
            </span>
            <span className="tabbar-label">{tab.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
