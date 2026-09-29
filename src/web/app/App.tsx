import { lazy, Suspense } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { AuthFrame, ChangeCredentialsScreen, LoginScreen, UnlockScreen } from '../screens/Auth.tsx';
import { FeedbackProvider } from './feedback.tsx';
import { QueueProvider } from './queue.tsx';
import { SessionProvider, useSession } from './session.tsx';

// Role decides the default shell; each shell is its own chunk.
const MobileShell = lazy(() => import('../shells/MobileShell.tsx'));
const DesktopShell = lazy(() => import('../shells/DesktopShell.tsx'));

export function App() {
  return (
    <SessionProvider>
      <FeedbackProvider>
        <Root />
      </FeedbackProvider>
    </SessionProvider>
  );
}

function Root() {
  const { phase, refresh, can } = useSession();

  switch (phase.kind) {
    case 'booting':
      return (
        <AuthFrame>
          <div className="auth-card stack">
            {phase.waking ? (
              <p className="banner banner-warn" role="status">
                <Icon name="cloud" size={18} /> {t.serverWaking}
              </p>
            ) : null}
            <Skeleton lines={4} />
          </div>
        </AuthFrame>
      );
    case 'unreachable':
      return (
        <AuthFrame>
          <div className="auth-card stack">
            <p className="form-error" role="alert">
              <Icon name="wifiOff" size={18} /> <span>{t.serverUnreachable}</span>
            </p>
            <button type="button" className="btn btn-primary btn-block" onClick={() => void refresh()}>
              <Icon name="refresh" />
              {t.retry}
            </button>
          </div>
        </AuthFrame>
      );
    case 'anonymous':
      return <LoginScreen />;
    case 'must_change':
      return <ChangeCredentialsScreen info={phase.info} />;
    case 'locked':
      return <UnlockScreen info={phase.info} />;
    case 'ready': {
      const shell =
        phase.info.user.role === 'master' ? <DesktopShell /> : <MobileShell offline={phase.offline} />;
      return (
        <Suspense fallback={<Skeleton lines={8} />}>
          {can('workinv.use') ? <QueueProvider>{shell}</QueueProvider> : shell}
        </Suspense>
      );
    }
  }
}
