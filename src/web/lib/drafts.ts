// A half-filled invoice form is kept on this phone, so switching to WhatsApp or a call, or the
// phone closing the app, loses nothing (owner, 30 Sep 2026). Cleared once the invoice is saved
// or copied, after 24 hours, and on sign-out (shared phones).

const DRAFT_PREFIX = 'ahc.draft.v1.';
const DRAFT_MAX_AGE_MS = 24 * 3600_000;

export interface Draft<T> {
  form: T;
  /** The idempotency key, so a restored form never creates a second record. */
  key: string;
  savedAt: number;
}

export function readDraft<T>(key: string): Draft<T> | null {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as Draft<T>;
    return Date.now() - draft.savedAt > DRAFT_MAX_AGE_MS ? null : draft;
  } catch {
    return null;
  }
}

export function writeDraft<T>(key: string, draft: Draft<T> | null): void {
  try {
    if (draft) localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify(draft));
    else localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    // storage unavailable: the form simply isn't kept
  }
}

/** Drops every kept form (on sign-out). */
export function clearFormDrafts(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k);
  } catch {
    // nothing kept
  }
}
