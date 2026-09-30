import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react';
import { isOverdue, useQueue } from '../app/queue.tsx';
import { useSession, useUser } from '../app/session.tsx';
import { Icon, Logo, type IconName } from '../components/Icon.tsx';
import { Initials, Skeleton, ThemeToggle } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { ageLabel } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { JobForm } from '../screens/JobForm.tsx';

const Dashboard = lazy(() => import('../screens/Dashboard.tsx').then((m) => ({ default: m.Dashboard })));
const WorkInv = lazy(() => import('../screens/WorkInv.tsx').then((m) => ({ default: m.WorkInv })));
const Invoices = lazy(() => import('../screens/Invoices.tsx').then((m) => ({ default: m.Invoices })));
const VoidRequests = lazy(() => import('../screens/Invoices.tsx').then((m) => ({ default: m.VoidRequests })));
const WorkOrders = lazy(() => import('../screens/WorkOrders.tsx').then((m) => ({ default: m.WorkOrders })));
const Team = lazy(() => import('../screens/Team.tsx').then((m) => ({ default: m.Team })));

const NAV: Array<{ path: string; label: string; icon: IconName; key: string }> = [
  { path: '/dashboard', label: t.navDashboard, icon: 'grid', key: '1' },
  { path: '/work-inv', label: t.navWorkInv, icon: 'inbox', key: '2' },
  { path: '/new-invoice', label: t.navNewInvoice, icon: 'plus', key: '3' },
  { path: '/invoices', label: t.navInvoices, icon: 'receipt', key: '4' },
  { path: '/void-requests', label: t.navVoidRequests, icon: 'ban', key: '5' },
  { path: '/work-orders', label: t.navWorkOrders, icon: 'clipboard', key: '6' },
  { path: '/team', label: t.navTeam, icon: 'users', key: '7' },
];

/**
 * Master's desktop shell (1366×768 and up): a slim icon rail on the left, a top bar with
 * live status chips, invoice search and the signed-in user. Collapses to a top row on narrow
 * screens so nothing breaks if opened on a phone. Alt+1…7 switch sections; "/" focuses search.
 */
export default function DesktopShell() {
  const info = useUser();
  const { logout } = useSession();
  const { snapshot } = useQueue();
  const { path, search } = useLocation();
  const current = NAV.some((n) => n.path === path) ? path : '/dashboard';
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (current !== path) navigate(current, true);
  }, [current, path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey) {
        const item = NAV.find((n) => n.key === e.key);
        if (item) {
          e.preventDefault();
          navigate(item.path);
        }
      } else if (e.key === '/' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        document.getElementById('top-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    navigate(q ? `/invoices?q=${encodeURIComponent(q)}` : '/invoices');
    setQuery('');
  }

  const overdue = isOverdue(snapshot);
  return (
    <div className="desk">
      <aside className="rail" aria-label="Main">
        <span className="rail-logo" title={t.appName}>
          <Logo size={44} />
        </span>
        <nav className="rail-nav">
          {NAV.map((n) => (
            <button
              key={n.path}
              type="button"
              className={`rail-item${n.path === current ? ' rail-item-on' : ''}`}
              aria-current={n.path === current ? 'page' : undefined}
              aria-label={n.label}
              title={`${n.label} (Alt+${n.key})`}
              onClick={() => navigate(n.path)}
            >
              <Icon name={n.icon} />
              {n.path === '/work-inv' && snapshot?.pendingCount ? (
                <span className={`rail-badge${overdue ? ' rail-badge-bad' : ''}`}>{snapshot.pendingCount}</span>
              ) : null}
              <span className="rail-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <ThemeToggle />
          <button type="button" className="icon-btn" aria-label={t.signOut} title={t.signOut} onClick={() => void logout()}>
            <Icon name="logout" />
          </button>
        </div>
      </aside>

      <div className="desk-main">
        <header className="topbar">
          <div className="topbar-chips">
            <button type="button" className={`top-chip${overdue ? ' top-chip-warn' : ''}`} onClick={() => navigate('/work-inv')}>
              <Icon name="inbox" size={16} />
              {t.chipWaiting} <strong>{snapshot?.pendingCount ?? '–'}</strong>
            </button>
            {snapshot?.oldestPendingAt && snapshot.pendingCount > 0 ? (
              <span className={`top-chip${overdue ? ' top-chip-warn' : ''}`}>
                <Icon name="clock" size={16} />
                {t.chipOldest} <strong>{ageLabel(snapshot.oldestPendingAt)}</strong>
              </span>
            ) : null}
          </div>
          <form className="top-search" role="search" onSubmit={onSearch}>
            <Icon name="search" size={18} />
            <input
              id="top-search"
              type="search"
              placeholder={t.topSearch}
              aria-label={t.topSearch}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>/</kbd>
          </form>
          <div className="top-user">
            <Initials name={info.user.displayName} />
            <div>
              <strong>{info.user.displayName}</strong>
              <span className="muted small">{t.roleLabel[info.user.role]}</span>
            </div>
          </div>
        </header>

        <main className="desk-content">
          <Suspense fallback={<Skeleton lines={10} />}>
            {current === '/dashboard' ? <Dashboard /> : null}
            {current === '/work-inv' ? <WorkInv /> : null}
            {current === '/new-invoice' ? (
              <section className="page narrow">
                <header className="page-head">
                  <div>
                    <h2 className="page-title">{t.navNewInvoice}</h2>
                    <p className="page-sub">{t.newInvoiceIntro}</p>
                  </div>
                </header>
                <JobForm mode="copy" />
              </section>
            ) : null}
            {current === '/invoices' ? <Invoices key={search} initialQuery={new URLSearchParams(search).get('q') ?? ''} /> : null}
            {current === '/void-requests' ? <VoidRequests /> : null}
            {current === '/work-orders' ? <WorkOrders /> : null}
            {current === '/team' ? <Team /> : null}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
