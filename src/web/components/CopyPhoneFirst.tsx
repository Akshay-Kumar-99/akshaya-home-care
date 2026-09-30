import { useCallback, useState } from 'react';
import { useFeedback } from '../app/feedback.tsx';
import { t } from '../i18n/en.ts';
import { copyWhenReady } from '../lib/clipboard.ts';
import { Icon } from './Icon.tsx';

// Owner (30 Sep 2026): copying an invoice gives two things, in this order: first the customer's
// phone number (to paste into WhatsApp search), then the invoice message. A phone's clipboard
// holds one item at a time, so they are two taps. The step is remembered for this browser tab
// (sessionStorage), so going to WhatsApp and back, even if the phone reloads the app, lands
// on "Copy invoice".

const PREFIX = 'ahc.copyphone.';

function isDone(key: string): boolean {
  try {
    return sessionStorage.getItem(PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function setDone(key: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(PREFIX + key, '1');
    else sessionStorage.removeItem(PREFIX + key);
  } catch {
    // storage unavailable: the step lasts only while the screen is open
  }
}

/** "+919876543210" → "9876543210": the form that finds the contact in WhatsApp search. */
export function phoneForSearch(e164: string): string {
  return e164.replace(/\D/g, '').slice(-10);
}

/** Whether the phone number has been copied for `key` (null: no step to track yet). */
export function usePhoneStep(key: string | null) {
  const [, rerender] = useState(0);
  const [fallback, setFallback] = useState<string | null>(null);
  const done = key !== null && (isDone(key) || fallback === key);
  const set = useCallback(
    (on: boolean) => {
      if (!key) return;
      setDone(key, on);
      setFallback(on ? key : null);
      rerender((n) => n + 1);
    },
    [key],
  );
  return { done, markDone: () => set(true), clear: () => set(false) };
}

/** Copies the 10-digit phone number and says so; must run inside the tap. */
export function useCopyPhone(): (e164: string) => void {
  const { toast, showCopyFallback } = useFeedback();
  return useCallback(
    (e164: string) => {
      const digits = phoneForSearch(e164);
      void copyWhenReady(Promise.resolve(digits)).then((ok) => {
        if (ok) toast({ text: t.phoneCopied(digits), tone: 'ok', durationMs: 6000 });
        else showCopyFallback(digits);
      });
    },
    [toast, showCopyFallback],
  );
}

/**
 * Tap 1 "Copy phone", tap 2 "Copy invoice" (or "Copy again"). `onCopyInvoice` must start its
 * clipboard write synchronously and resolve true once the invoice was copied.
 */
export function PhoneThenInvoice(props: {
  stepKey: string;
  phone: string;
  invoiceLabel: string;
  onCopyInvoice: () => Promise<boolean>;
  disabled?: boolean;
  large?: boolean;
}) {
  const step = usePhoneStep(props.stepKey);
  const copyPhone = useCopyPhone();
  const cls = `btn btn-primary btn-block${props.large ? ' btn-large' : ''}`;

  if (!step.done) {
    return (
      <button
        type="button"
        className={cls}
        disabled={props.disabled}
        onClick={() => {
          copyPhone(props.phone);
          step.markDone();
        }}
      >
        <Icon name="phone" />
        {t.copyPhone}
      </button>
    );
  }
  return (
    <div className="copy-pair">
      <button
        type="button"
        className={cls}
        disabled={props.disabled}
        onClick={() => {
          void props.onCopyInvoice().then((ok) => {
            if (ok) step.clear();
          });
        }}
      >
        <Icon name="copy" />
        {props.invoiceLabel}
      </button>
      <button type="button" className="link-button" onClick={() => copyPhone(props.phone)}>
        {t.copyPhoneAgain}
      </button>
    </div>
  );
}
