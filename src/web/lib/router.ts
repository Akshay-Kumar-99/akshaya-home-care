import { useEffect, useState } from 'react';

// A tiny pathname router: the app has a handful of top-level screens, so a routing library
// would cost more bundle than it saves. The server falls back to index.html for these paths.

const EVENT = 'ahc:navigate';

/** Navigates to a path, optionally with a query string ("/invoices?q=48213"). */
export function navigate(target: string, replace = false): void {
  if (target === window.location.pathname + window.location.search) return;
  if (replace) window.history.replaceState(null, '', target);
  else window.history.pushState(null, '', target);
  window.dispatchEvent(new Event(EVENT));
}

function snapshot(): { path: string; search: string } {
  return { path: window.location.pathname, search: window.location.search };
}

export function useLocation(): { path: string; search: string } {
  const [loc, setLoc] = useState(snapshot);
  useEffect(() => {
    const update = () =>
      setLoc((prev) => {
        const next = snapshot();
        return prev.path === next.path && prev.search === next.search ? prev : next;
      });
    window.addEventListener('popstate', update);
    window.addEventListener(EVENT, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(EVENT, update);
    };
  }, []);
  return loc;
}

export function usePath(): string {
  return useLocation().path;
}
