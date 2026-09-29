// Thin fetch wrapper. Adds the per-session CSRF header on state changes, marks background
// polls (which do not count as activity and never wake the database), and turns auth
// failures into app-wide events (sign-in, PIN unlock, first-login change).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown> | null;

  constructor(status: number, code: string, body: Record<string, unknown> | null) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** True for failures where the request never reached the server (offline, DNS, cold start timeout). */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof DOMException && err.name === 'AbortError');
}

export type AuthEvent = 'unauthenticated' | 'pin_required' | 'must_change';
const listeners = new Set<(event: AuthEvent) => void>();

export function onAuthEvent(listener: (event: AuthEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function csrfToken(): string {
  const match = /(?:^|;\s*)(?:__Host-)?ahc_csrf=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : '';
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  /** Automatic polls: not user activity; answered without a DB query where possible. */
  background?: boolean;
  signal?: AbortSignal;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken();
  if (options.background) headers['x-ahc-background'] = '1';

  const res = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: 'same-origin',
    cache: 'no-store',
    signal: options.signal,
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : `http_${res.status}`;
    if (code === 'unauthenticated') listeners.forEach((l) => l('unauthenticated'));
    if (code === 'pin_required') listeners.forEach((l) => l('pin_required'));
    if (code === 'must_change_credentials') listeners.forEach((l) => l('must_change'));
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}
