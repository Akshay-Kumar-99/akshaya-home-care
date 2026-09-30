import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { TeamMember } from '../../shared/api-types.ts';
import { roleUsesPin, type TechnicianMode } from '../../shared/constants.ts';
import { checkNewPassword, checkNewPin } from '../../shared/credentials.ts';
import { StepUpCancelled, useFeedback } from '../app/feedback.tsx';
import { useUser } from '../app/session.tsx';
import { Icon } from '../components/Icon.tsx';
import { Chips, Dialog, EmptyState, Field, Initials, SecretInput, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError, isNetworkError } from '../lib/api.ts';
import { dateTimeIst } from '../lib/format.ts';

// Master-only Team panel: add, edit, remove / restore users, set their password or PIN, sign
// them out everywhere. The server asks for a fresh PIN (step-up) on every change.

type NewRole = 'admin_technician' | 'technician';

interface LoginAttempt {
  id: number;
  usernameAttempted: string;
  displayName: string | null;
  ip: string | null;
  stage: string;
  success: boolean;
  failureReason: string | null;
  createdAt: string;
}

const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomIndex(n: number): number {
  const buf = new Uint32Array(1);
  // Rejection sampling: no modulo bias.
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}

function generatePassword(username: string): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < 14; i++) out += PASSWORD_ALPHABET[randomIndex(PASSWORD_ALPHABET.length)];
    if (!checkNewPassword(out, username || 'x')) return out;
  }
}

function generatePin(): string {
  for (;;) {
    let out = '';
    for (let i = 0; i < 6; i++) out += String(randomIndex(10));
    if (!checkNewPin(out)) return out;
  }
}

function errorText(err: unknown): string {
  if (isNetworkError(err)) return t.offlineAction;
  if (err instanceof ApiError) return t.teamErrors[err.code] ?? t.credentialErrors[err.code] ?? t.somethingWrong;
  return t.somethingWrong;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p className="form-error" role="alert">
      <Icon name="alert" size={18} /> <span>{text}</span>
    </p>
  ) : null;
}

function DialogButtons(props: { onCancel: () => void; busy: boolean; label: string; danger?: boolean; disabled?: boolean }) {
  return (
    <div className="row">
      <button type="button" className="btn grow" onClick={props.onCancel}>
        {t.cancel}
      </button>
      <button type="submit" className={`btn ${props.danger ? 'btn-danger-solid' : 'btn-primary'} grow`} disabled={props.busy || props.disabled}>
        {props.label}
      </button>
    </div>
  );
}

/** A secret the Master types or generates; shown in clear so it can be read out. */
function GeneratedSecret(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onGenerate: () => void;
  numeric?: boolean;
  hint?: string;
}) {
  return (
    <Field label={props.label} icon={props.numeric ? 'lock' : 'key'} hint={props.hint}>
      <span className="secret-row">
        <input
          className="mono"
          autoComplete="off"
          spellCheck={false}
          inputMode={props.numeric ? 'numeric' : undefined}
          maxLength={props.numeric ? 12 : 256}
          value={props.value}
          onChange={(e) => props.onChange(props.numeric ? digitsOnly(e.target.value) : e.target.value)}
        />
        <button type="button" className="btn btn-small" onClick={props.onGenerate}>
          {t.generate}
        </button>
      </span>
    </Field>
  );
}

/** The Team tab of Settings (Master only). */
export function Team() {
  const me = useUser();
  const { toast, withStepUp } = useFeedback();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [history, setHistory] = useState<LoginAttempt[] | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);

  const load = useCallback(async () => {
    try {
      const [users, attempts] = await Promise.all([
        api<{ users: TeamMember[] }>('/api/admin/users'),
        api<{ attempts: LoginAttempt[] }>('/api/admin/login-history?limit=30'),
      ]);
      setMembers(users.users);
      setHistory(attempts.attempts);
    } catch (err) {
      if (!isNetworkError(err)) toast({ text: errorText(err), tone: 'error' });
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const close = (changed: boolean) => {
    setDialog(null);
    if (changed) void load();
  };

  async function signOutEverywhere(member: TeamMember) {
    try {
      const res = await withStepUp(() => api<{ revoked: number }>(`/api/admin/users/${member.id}/revoke-sessions`, { method: 'POST' }));
      toast({ text: t.signedOutEverywhere(res.revoked), tone: 'ok' });
      void load();
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) toast({ text: errorText(err), tone: 'error' });
    }
  }

  const active = (members ?? []).filter((m) => m.status === 'active');
  const removed = (members ?? []).filter((m) => m.status !== 'active');

  const card = (m: TeamMember) => {
    const isMe = m.id === me.user.id;
    return (
      <article key={m.id} className={`card team-card${m.status !== 'active' ? ' team-card-off' : ''}`}>
        <div className="queue-card-head">
          <Initials name={m.displayName} />
          <div className="queue-card-who">
            <h3 className="item-title">{m.displayName}</h3>
            <span className="muted small mono">@{m.username}</span>
          </div>
        </div>
        <div className="pills">
          <span className="pill">{t.roleLabel[m.roleKey]}</span>
          {m.technicianMode ? (
            <span className={`pill ${m.technicianMode === 'invoice_and_work' ? 'pill-gold' : 'pill-muted'}`}>
              <Icon name={m.technicianMode === 'invoice_and_work' ? 'clipboard' : 'receipt'} size={14} />
              {t.technicianMode[m.technicianMode]}
            </span>
          ) : null}
          {isMe ? <span className="pill pill-issued">{t.you}</span> : null}
          {m.status !== 'active' ? <span className="pill pill-bad">{t.statusRemoved}</span> : null}
          {m.mustChange && m.status === 'active' ? <span className="pill pill-warn">{t.mustChangePending}</span> : null}
        </div>
        <ul className="meta">
          <li>
            <Icon name="clock" size={16} />
            <span>
              {t.lastSignIn}: {m.lastLoginAt ? dateTimeIst(m.lastLoginAt) : t.never}
              {m.activeSessions > 0 ? ` · ${t.devicesSignedIn(m.activeSessions)}` : ''}
            </span>
          </li>
          {m.technicianMode === 'invoice_and_work' ? (
            <li>
              <Icon name="clipboard" size={16} />
              <span>{t.openJobsCount(m.openJobs)}</span>
            </li>
          ) : null}
        </ul>
        <div className="team-actions">
          {m.status === 'active' ? (
            <>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setDialog(<EditUserDialog member={m} onClose={close} />)}>
                <Icon name="edit" size={16} />
                {t.editUser}
              </button>
              {isMe ? (
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setDialog(<MyAccountDialog onClose={close} />)}>
                  <Icon name="key" size={16} />
                  {t.myAccount}
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setDialog(<CredentialsDialog member={m} onClose={close} />)}>
                    <Icon name="key" size={16} />
                    {t.setCredentials}
                  </button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => void signOutEverywhere(m)} disabled={m.activeSessions === 0}>
                    <Icon name="logout" size={16} />
                    {t.signOutEverywhere}
                  </button>
                  {m.roleKey !== 'master' ? (
                    <button
                      type="button"
                      className="btn btn-small btn-ghost btn-danger"
                      onClick={() => setDialog(<StatusDialog member={m} onClose={close} />)}
                    >
                      <Icon name="ban" size={16} />
                      {t.removeUser}
                    </button>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => setDialog(<StatusDialog member={m} onClose={close} />)}>
              <Icon name="undo" size={16} />
              {t.restoreUser}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <p className="page-sub">{t.teamIntro}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setDialog(<AddUserDialog onClose={close} show={setDialog} />)}>
          <Icon name="userPlus" size={18} />
          {t.addUser}
        </button>
      </header>

      {members === null ? <Skeleton lines={8} /> : null}
      {members && members.length === 0 ? <EmptyState icon="users" title={t.navTeam} /> : null}
      <div className="cards cards-grid">{active.map(card)}</div>
      {removed.length > 0 ? (
        <>
          <h3 className="list-heading">{t.statusRemoved}</h3>
          <div className="cards cards-grid">{removed.map(card)}</div>
        </>
      ) : null}

      {history && history.length > 0 ? (
        <>
          <h3 className="list-heading">{t.recentSignIns}</h3>
          <div className="table-wrap">
            <table className="table table-static">
              <thead>
                <tr>
                  <th>{t.date}</th>
                  <th>{t.username}</th>
                  <th>{t.colStep}</th>
                  <th>{t.colResult}</th>
                  <th>{t.colIp}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((a) => (
                  <tr key={a.id}>
                    <td className="when">{dateTimeIst(a.createdAt)}</td>
                    <td data-label={t.username}>
                      <strong>{a.displayName ?? a.usernameAttempted}</strong>
                      {a.displayName ? <span className="muted small mono"> @{a.usernameAttempted}</span> : null}
                    </td>
                    <td data-label={t.colStep}>{t.stageLabel[a.stage] ?? a.stage}</td>
                    <td data-label={t.colResult}>
                      <span className={`pill ${a.success ? 'pill-issued' : 'pill-bad'}`}>
                        {a.success ? t.signInResult.ok : (t.signInResult[a.failureReason ?? ''] ?? a.failureReason)}
                      </span>
                    </td>
                    <td data-label={t.colIp} className="mono small">
                      {a.ip ?? '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {dialog}
    </div>
  );
}

function TypeChips(props: { value: TechnicianMode | null; onChange: (v: TechnicianMode) => void; error?: string | null }) {
  return (
    <div className="stack-sm">
      <Chips<TechnicianMode>
        label={t.technicianType}
        options={[
          { value: 'invoice_only', label: t.technicianMode.invoice_only! },
          { value: 'invoice_and_work', label: t.technicianMode.invoice_and_work! },
        ]}
        value={props.value}
        onChange={props.onChange}
        error={props.error}
      />
      {props.value ? <p className="muted small">{t.technicianModeHint[props.value]}</p> : null}
    </div>
  );
}

/** Shown once after creating a user or setting their password / PIN. */
function CredentialsCard(props: { name: string; username: string; password?: string; pin?: string; onClose: () => void }) {
  const { toast, showCopyFallback } = useFeedback();
  const text = [
    `${t.appName}`,
    `${t.displayName}: ${props.name}`,
    `${t.username}: ${props.username}`,
    props.password ? `${t.password}: ${props.password}` : null,
    props.pin ? `${t.pinOffice}: ${props.pin}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast({ text: t.detailsCopied, tone: 'ok' });
    } catch {
      showCopyFallback(text);
    }
  }

  return (
    <Dialog title={t.userCreatedTitle} onClose={props.onClose}>
      <div className="stack">
        <p className="muted">{t.credentialsOnce}</p>
        <dl className="cred-list">
          <dt>{t.username}</dt>
          <dd className="mono">{props.username}</dd>
          {props.password ? (
            <>
              <dt>{t.password}</dt>
              <dd className="mono">{props.password}</dd>
            </>
          ) : null}
          {props.pin ? (
            <>
              <dt>{t.pinOffice}</dt>
              <dd className="mono">{props.pin}</dd>
            </>
          ) : null}
        </dl>
        <div className="row">
          <button type="button" className="btn grow" onClick={() => void copy()}>
            <Icon name="copy" size={18} />
            {t.copyDetails}
          </button>
          <button type="button" className="btn btn-primary grow" onClick={props.onClose}>
            {t.done}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function AddUserDialog({ onClose, show }: { onClose: (changed: boolean) => void; show: (node: ReactNode) => void }) {
  const { withStepUp } = useFeedback();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<NewRole | null>(null);
  const [mode, setMode] = useState<TechnicianMode | null>(null);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found: Record<string, string> = {};
    if (!name.trim()) found.name = t.required;
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/i.test(username.trim())) found.username = 'Use 3–32 letters, digits, dot, dash or underscore.';
    if (!role) found.role = t.required;
    if (role === 'technician' && !mode) found.mode = t.chooseType;
    const pwProblem = checkNewPassword(password, username.trim() || 'x');
    if (pwProblem) found.password = t.credentialErrors[pwProblem] ?? t.required;
    if (role === 'admin_technician') {
      const pinProblem = checkNewPin(pin);
      if (pinProblem) found.pin = t.credentialErrors[pinProblem] ?? t.required;
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const body = {
        displayName: name.trim(),
        username: username.trim(),
        role,
        technicianMode: role === 'technician' ? mode : null,
        password,
        pin: role === 'admin_technician' ? pin : null,
        mustChange,
      };
      await withStepUp(() => api('/api/admin/users', { method: 'POST', body }));
      show(
        <CredentialsCard
          name={name.trim()}
          username={username.trim()}
          password={password}
          pin={role === 'admin_technician' ? pin : undefined}
          onClose={() => onClose(true)}
        />,
      );
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.addUserTitle} onClose={() => onClose(false)} wide>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="two-col">
          <Field label={t.displayName} icon="user" error={errors.name}>
            <input autoComplete="off" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t.username} icon="user" error={errors.username}>
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} />
          </Field>
        </div>
        <Chips<NewRole>
          label={t.role}
          segmented
          options={[
            { value: 'technician', label: t.roleLabel.technician! },
            { value: 'admin_technician', label: t.roleLabel.admin_technician! },
          ]}
          value={role}
          onChange={(v) => {
            setRole(v);
            setErrors((e) => ({ ...e, role: '', pin: '' }));
          }}
          error={errors.role || null}
        />
        {role === 'technician' ? (
          <TypeChips
            value={mode}
            onChange={(v) => {
              setMode(v);
              setErrors((e) => ({ ...e, mode: '' }));
            }}
            error={errors.mode || null}
          />
        ) : null}
        <div className="two-col">
          <GeneratedSecret label={t.password} value={password} onChange={setPassword} onGenerate={() => setPassword(generatePassword(username.trim()))} />
          {role === 'admin_technician' ? (
            <GeneratedSecret label={t.pinOffice} numeric value={pin} onChange={setPin} onGenerate={() => setPin(generatePin())} />
          ) : null}
        </div>
        {errors.password ? <ErrorLine text={errors.password} /> : null}
        {errors.pin ? <ErrorLine text={errors.pin} /> : null}
        <label className="check-row">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          <span>{t.mustChangeLabel}</span>
        </label>
        <ErrorLine text={error} />
        <DialogButtons onCancel={() => onClose(false)} busy={busy} label={t.createUser} />
      </form>
    </Dialog>
  );
}

function EditUserDialog({ member, onClose }: { member: TeamMember; onClose: (changed: boolean) => void }) {
  const { toast, withStepUp } = useFeedback();
  const [name, setName] = useState(member.displayName);
  const [username, setUsername] = useState(member.username);
  const [mode, setMode] = useState<TechnicianMode | null>(member.technicianMode);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const changes: Record<string, string> = {};
    if (name.trim() && name.trim() !== member.displayName) changes.displayName = name.trim();
    if (username.trim() && username.trim() !== member.username) changes.username = username.trim();
    if (mode && mode !== member.technicianMode) changes.technicianMode = mode;
    if (Object.keys(changes).length === 0) return onClose(false);
    setBusy(true);
    setError(null);
    try {
      await withStepUp(() => api(`/api/admin/users/${member.id}`, { method: 'PATCH', body: changes }));
      toast({ text: t.userSaved, tone: 'ok' });
      onClose(true);
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.editUserTitle(member.displayName)} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <Field label={t.displayName} icon="user">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </Field>
        <Field label={t.username} icon="user">
          <input autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} maxLength={32} />
        </Field>
        {member.roleKey === 'technician' ? <TypeChips value={mode} onChange={setMode} /> : null}
        <ErrorLine text={error} />
        <DialogButtons onCancel={() => onClose(false)} busy={busy} label={t.save} />
      </form>
    </Dialog>
  );
}

function CredentialsDialog({ member, onClose }: { member: TeamMember; onClose: (changed: boolean) => void }) {
  const { withStepUp } = useFeedback();
  const usesPin = roleUsesPin(member.roleKey);
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password && !pin) return setError(t.keepEmpty);
    if (password) {
      const problem = checkNewPassword(password, member.username);
      if (problem) return setError(t.credentialErrors[problem] ?? t.somethingWrong);
    }
    if (pin) {
      const problem = checkNewPin(pin);
      if (problem) return setError(t.credentialErrors[problem] ?? t.somethingWrong);
    }
    setBusy(true);
    setError(null);
    try {
      const body = { password: password || undefined, pin: pin || undefined, mustChange };
      await withStepUp(() => api(`/api/admin/users/${member.id}/credentials`, { method: 'POST', body }));
      setSaved(true);
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setError(errorText(err));
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <CredentialsCard
        name={member.displayName}
        username={member.username}
        password={password || undefined}
        pin={pin || undefined}
        onClose={() => onClose(true)}
      />
    );
  }

  return (
    <Dialog title={t.setCredentialsTitle(member.displayName)} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <GeneratedSecret
          label={t.password}
          hint={t.keepEmpty}
          value={password}
          onChange={setPassword}
          onGenerate={() => setPassword(generatePassword(member.username))}
        />
        {usesPin ? (
          <GeneratedSecret label={t.pinOffice} hint={t.keepEmpty} numeric value={pin} onChange={setPin} onGenerate={() => setPin(generatePin())} />
        ) : null}
        <label className="check-row">
          <input type="checkbox" checked={mustChange} onChange={(e) => setMustChange(e.target.checked)} />
          <span>{t.mustChangeLabel}</span>
        </label>
        <p className="muted small">{t.credentialsSaved}</p>
        <ErrorLine text={error} />
        <DialogButtons onCancel={() => onClose(false)} busy={busy} label={t.save} />
      </form>
    </Dialog>
  );
}

function StatusDialog({ member, onClose }: { member: TeamMember; onClose: (changed: boolean) => void }) {
  const { toast, withStepUp } = useFeedback();
  const removing = member.status === 'active';
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const path = `/api/admin/users/${member.id}/${removing ? 'disable' : 'enable'}`;
      await withStepUp(() => api(path, { method: 'POST', body: { reason: reason.trim() } }));
      toast({ text: removing ? t.userRemoved : t.userRestored, tone: 'ok' });
      onClose(true);
    } catch (err) {
      if (!(err instanceof StepUpCancelled)) setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Dialog title={removing ? t.removeTitle(member.displayName) : t.restoreTitle(member.displayName)} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <p className="muted">{removing ? t.removeIntro : t.restoreIntro}</p>
        <Field label={t.reason}>
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required />
        </Field>
        <ErrorLine text={error} />
        <DialogButtons
          onCancel={() => onClose(false)}
          busy={busy}
          disabled={!reason.trim()}
          danger={removing}
          label={removing ? t.removeUser : t.restoreUser}
        />
      </form>
    </Dialog>
  );
}

/** The Master's own password and PIN (needs the current password). */
function MyAccountDialog({ onClose }: { onClose: (changed: boolean) => void }) {
  const { toast } = useFeedback();
  const [form, setForm] = useState({ current: '', password: '', password2: '', pin: '', pin2: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: key.startsWith('pin') ? digitsOnly(e.target.value) : e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.password2) return setError(t.passwordsDontMatch);
    if (form.pin !== form.pin2) return setError(t.pinsDontMatch);
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ recoveryCodes: string[] | null }>('/api/auth/change-credentials', {
        method: 'POST',
        body: { currentPassword: form.current, newPassword: form.password, newPin: form.pin },
      });
      toast({ text: t.userSaved, tone: 'ok' });
      // All recovery codes had been used: the server issued a fresh set, shown once.
      if (res.recoveryCodes) setCodes(res.recoveryCodes);
      else onClose(true);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  if (codes) {
    return (
      <Dialog title={t.recoveryCodesTitle} onClose={() => onClose(true)}>
        <div className="stack">
          <p className="muted">{t.recoveryCodesIntro}</p>
          <ol className="codes">
            {codes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-primary btn-block" onClick={() => onClose(true)}>
            {t.savedCodes}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t.myAccount} onClose={() => onClose(false)}>
      <form className="stack" onSubmit={submit}>
        <Field label={t.currentPassword} icon="lock">
          <SecretInput autoComplete="current-password" value={form.current} onChange={set('current')} required />
        </Field>
        <Field label={t.newPassword} icon="lock">
          <SecretInput autoComplete="new-password" value={form.password} onChange={set('password')} required />
        </Field>
        <Field label={t.confirmPassword} icon="lock">
          <SecretInput autoComplete="new-password" value={form.password2} onChange={set('password2')} required />
        </Field>
        <div className="two-col">
          <Field label={t.newPin} icon="lock">
            <SecretInput inputMode="numeric" maxLength={12} value={form.pin} onChange={set('pin')} required />
          </Field>
          <Field label={t.confirmPin} icon="lock">
            <SecretInput inputMode="numeric" maxLength={12} value={form.pin2} onChange={set('pin2')} required />
          </Field>
        </div>
        <ErrorLine text={error} />
        <DialogButtons onCancel={() => onClose(false)} busy={busy} label={t.save} />
      </form>
    </Dialog>
  );
}
