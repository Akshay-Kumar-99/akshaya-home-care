import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';
import { Dialog, Field, SecretInput } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api, ApiError } from '../lib/api.ts';

// Toasts, the step-up PIN prompt and the copy fallback, available to every screen.

export interface ToastSpec {
  text: string;
  tone?: 'ok' | 'error' | 'info';
  durationMs?: number;
}

interface FeedbackApi {
  toast: (spec: ToastSpec) => void;
  /** Runs `fn`; if the server asks for a fresh PIN, prompts for it and retries once. */
  withStepUp: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Shows the select-and-copy fallback when automatic clipboard copy fails. */
  showCopyFallback: (text: string) => void;
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export class StepUpCancelled extends Error {}

const TONE_ICON = { ok: 'checkCircle', error: 'alert', info: 'bell' } as const;

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastSpec & { id: number }) | null>(null);
  const [pinPrompt, setPinPrompt] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [fallbackText, setFallbackText] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const showToast = useCallback((spec: ToastSpec) => {
    window.clearTimeout(timer.current);
    setToast({ ...spec, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), spec.durationMs ?? 5000);
  }, []);

  const requestPin = useCallback(() => new Promise<boolean>((resolve) => setPinPrompt({ resolve })), []);

  const withStepUp = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'step_up_required') throw err;
        if (!(await requestPin())) throw new StepUpCancelled();
        return fn();
      }
    },
    [requestPin],
  );

  const tone = toast?.tone ?? 'info';
  return (
    <FeedbackContext.Provider value={{ toast: showToast, withStepUp, showCopyFallback: setFallbackText }}>
      {children}
      {toast ? (
        <div key={toast.id} className={`toast toast-${tone}`} role="status" aria-live="polite">
          <Icon name={TONE_ICON[tone]} size={22} />
          <span className="toast-text">{toast.text}</span>
          <button type="button" className="toast-close" aria-label={t.close} onClick={() => setToast(null)}>
            <Icon name="x" size={18} />
          </button>
        </div>
      ) : null}
      {pinPrompt ? (
        <StepUpDialog
          onDone={(ok) => {
            pinPrompt.resolve(ok);
            setPinPrompt(null);
          }}
        />
      ) : null}
      {fallbackText !== null ? <CopyFallback text={fallbackText} onDone={() => setFallbackText(null)} /> : null}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): FeedbackApi {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback outside FeedbackProvider');
  return ctx;
}

function StepUpDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/verify-pin', { method: 'POST', body: { pin, purpose: 'step_up' } });
      onDone(true);
    } catch (err) {
      const left = err instanceof ApiError ? Number(err.body?.remainingAttempts ?? 0) : 0;
      setError(err instanceof ApiError && err.code === 'invalid_pin' ? t.wrongPin(left) : t.somethingWrong);
      setPin('');
      setBusy(false);
    }
  }

  return (
    <Dialog title={t.stepUpTitle} onClose={() => onDone(false)}>
      <form onSubmit={submit} className="stack">
        <p className="muted">{t.stepUpIntro}</p>
        <Field label={t.pinOffice} error={error} icon="lock">
          <SecretInput
            inputMode="numeric"
            autoComplete="off"
            pattern="[0-9]*"
            maxLength={12}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        </Field>
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onDone(false)}>
            {t.cancel}
          </button>
          <button type="submit" className="btn btn-primary grow" disabled={busy || pin.length < 6}>
            {t.confirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function CopyFallback({ text, onDone }: { text: string; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, el.value.length);
  }, []);
  return (
    <Dialog title={t.clipboardFallbackTitle} onClose={onDone}>
      <p className="muted">{t.clipboardFallbackIntro}</p>
      <textarea ref={ref} className="copy-fallback" readOnly value={text} rows={12} />
      <button type="button" className="btn btn-primary btn-block" onClick={onDone}>
        {t.done}
      </button>
    </Dialog>
  );
}
