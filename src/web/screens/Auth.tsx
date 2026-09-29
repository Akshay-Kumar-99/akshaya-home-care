import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import type { SessionInfo } from '../../shared/api-types.ts';
import { roleUsesPin } from '../../shared/constants.ts';
import { useSession } from '../app/session.tsx';
import { Icon, Logo } from '../components/Icon.tsx';
import { Field, SecretInput, ThemeToggle } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError } from '../lib/api.ts';

function deviceKind(): 'mobile' | 'desktop' {
  return window.matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop';
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

/** Shared frame for the sign-in family of screens: glow backdrop, brand, one card. */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <header className="auth-brand">
        <Logo size={56} />
        <div>
          <h1>{t.appName}</h1>
          <p>{t.tagline}</p>
        </div>
      </header>
      {children}
    </main>
  );
}

function FormMessage({ tone, children }: { tone: 'error' | 'ok'; children: ReactNode }) {
  return (
    <p className={tone === 'error' ? 'form-error' : 'form-ok'} role="alert">
      <Icon name={tone === 'error' ? 'alert' : 'checkCircle'} size={18} />
      <span>{children}</span>
    </p>
  );
}

export function LoginScreen() {
  const { setInfo } = useSession();
  const [mode, setMode] = useState<'login' | 'recover'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const info = await api<SessionInfo>('/api/auth/login', {
        method: 'POST',
        body: { username: username.trim(), password, pin, deviceKind: deviceKind() },
      });
      setInfo(info);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'too_many_attempts') {
        setError(t.tooManyAttempts(Math.ceil(Number(err.body?.retryAfterSec ?? 60) / 60)));
      } else if (err instanceof ApiError && err.code === 'invalid_credentials') {
        setError(t.invalidCredentials);
      } else {
        setError(err instanceof ApiError ? t.somethingWrong : t.serverUnreachable);
      }
      setPassword('');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'recover') return <RecoverScreen onBack={() => setMode('login')} />;

  return (
    <AuthFrame>
      <form className="auth-card stack" onSubmit={submit}>
        <div>
          <h2>{t.loginTitle}</h2>
          <p className="muted">{t.loginIntro}</p>
        </div>
        <Field label={t.username} icon="user">
          <input
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </Field>
        <Field label={t.password} icon="lock">
          <SecretInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        <Field label={t.pinOffice} hint={t.pinHintTechnician} icon="lock">
          <SecretInput
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
          />
        </Field>
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
          {busy ? t.signingIn : t.signIn}
        </button>
        <button type="button" className="link-button" onClick={() => setMode('recover')}>
          {t.forgotMaster}
        </button>
      </form>
    </AuthFrame>
  );
}

function RecoverScreen({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState({ username: '', recoveryCode: '', newPassword: '', newPin: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await api<{ remainingCodes: number }>('/api/auth/recover', { method: 'POST', body: form });
      setMessage({ ok: true, text: t.recoverDone(res.remainingCodes) });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      const text =
        code === 'invalid_recovery'
          ? t.recoverInvalid
          : code === 'too_many_attempts'
            ? t.tooManyAttempts(Math.ceil(Number((err as ApiError).body?.retryAfterSec ?? 60) / 60))
            : (t.credentialErrors[code] ?? t.somethingWrong);
      setMessage({ ok: false, text });
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: key === 'newPin' ? digitsOnly(e.target.value) : e.target.value });

  return (
    <AuthFrame>
      <form className="auth-card stack" onSubmit={submit}>
        <h2>{t.recoverTitle}</h2>
        <Field label={t.username} icon="user">
          <input autoCapitalize="none" value={form.username} onChange={set('username')} required />
        </Field>
        <Field label={t.recoveryCode} icon="receipt">
          <input autoCapitalize="characters" value={form.recoveryCode} onChange={set('recoveryCode')} required />
        </Field>
        <Field label={t.newPassword} icon="lock">
          <SecretInput autoComplete="new-password" value={form.newPassword} onChange={set('newPassword')} required />
        </Field>
        <Field label={t.newPin} icon="lock">
          <SecretInput inputMode="numeric" maxLength={12} value={form.newPin} onChange={set('newPin')} required />
        </Field>
        {message ? <FormMessage tone={message.ok ? 'ok' : 'error'}>{message.text}</FormMessage> : null}
        <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
          {t.recover}
        </button>
        <button type="button" className="link-button" onClick={onBack}>
          {t.backToLogin}
        </button>
      </form>
    </AuthFrame>
  );
}

export function ChangeCredentialsScreen({ info }: { info: SessionInfo }) {
  const { refresh, logout } = useSession();
  const usesPin = roleUsesPin(info.user.role);
  const [form, setForm] = useState({ current: '', password: '', password2: '', pin: '', pin2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.password2) return setError(t.passwordsDontMatch);
    if (usesPin && form.pin !== form.pin2) return setError(t.pinsDontMatch);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] | null }>('/api/auth/change-credentials', {
        method: 'POST',
        body: { currentPassword: form.current, newPassword: form.password, newPin: usesPin ? form.pin : undefined },
      });
      if (res.recoveryCodes) setCodes(res.recoveryCodes);
      else await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? (t.credentialErrors[err.code] ?? t.somethingWrong) : t.serverUnreachable);
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={() => void refresh()} />;

  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: key.startsWith('pin') ? digitsOnly(e.target.value) : e.target.value });

  return (
    <AuthFrame>
      <form className="auth-card stack" onSubmit={submit}>
        <div>
          <h2>{t.changeTitle}</h2>
          <p className="muted">{t.changeIntro}</p>
        </div>
        <Field label={t.currentPassword} icon="lock">
          <SecretInput autoComplete="current-password" value={form.current} onChange={set('current')} required />
        </Field>
        <Field label={t.newPassword} icon="lock">
          <SecretInput autoComplete="new-password" minLength={12} value={form.password} onChange={set('password')} required />
        </Field>
        <Field label={t.confirmPassword} icon="lock">
          <SecretInput autoComplete="new-password" value={form.password2} onChange={set('password2')} required />
        </Field>
        {usesPin ? (
          <>
            <Field label={t.newPin} icon="lock">
              <SecretInput inputMode="numeric" maxLength={12} value={form.pin} onChange={set('pin')} required />
            </Field>
            <Field label={t.confirmPin} icon="lock">
              <SecretInput inputMode="numeric" maxLength={12} value={form.pin2} onChange={set('pin2')} required />
            </Field>
          </>
        ) : null}
        {error ? <FormMessage tone="error">{error}</FormMessage> : null}
        <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>
          {busy ? t.saving : t.save}
        </button>
        <button type="button" className="link-button" onClick={() => void logout()}>
          {t.signOut}
        </button>
      </form>
    </AuthFrame>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function download() {
    const text = `${t.appName} · ${t.recoveryCodesTitle}\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'akshaya-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <AuthFrame>
      <div className="auth-card stack">
        <h2>{t.recoveryCodesTitle}</h2>
        <p className="muted">{t.recoveryCodesIntro}</p>
        <ol className="codes">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>
        <button type="button" className="btn" onClick={download}>
          {t.downloadCodes}
        </button>
        <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
          {t.savedCodes}
        </button>
      </div>
    </AuthFrame>
  );
}

export function UnlockScreen({ info }: { info: SessionInfo }) {
  const { refresh, logout } = useSession();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/verify-pin', { method: 'POST', body: { pin, purpose: 'unlock' } });
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_pin') {
        setError(t.wrongPin(Number(err.body?.remainingAttempts ?? 0)));
      } else if (!(err instanceof ApiError)) {
        setError(t.serverUnreachable);
      }
      setPin('');
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <form className="auth-card stack" onSubmit={submit}>
        <div>
          <h2>{t.lockedTitle}</h2>
          <p className="muted">
            {info.user.displayName} · {t.lockedIntro}
          </p>
        </div>
        <Field label={t.pinOffice} error={error} icon="lock">
          <SecretInput
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(digitsOnly(e.target.value))}
            autoFocus
          />
        </Field>
        <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy || pin.length < 6}>
          {t.unlock}
        </button>
        <button type="button" className="link-button" onClick={() => void logout()}>
          {t.signOut}
        </button>
      </form>
    </AuthFrame>
  );
}
