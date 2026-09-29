import { useCallback, useState } from 'react';

// Appearance: Auto follows the phone's setting; Dark and Light are fixed. Dark is the brand
// look; Light is easier to read in bright sunlight in the field. Stored per device.

export type ThemeChoice = 'auto' | 'dark' | 'light';
const KEY = 'ahc.theme';

export function readTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'dark' || value === 'light' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function useTheme(): { theme: ThemeChoice; cycle: () => void } {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);
  const cycle = useCallback(() => {
    setTheme((current) => {
      const next: ThemeChoice = current === 'auto' ? 'dark' : current === 'dark' ? 'light' : 'auto';
      applyTheme(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // not persisted
      }
      return next;
    });
  }, []);
  return { theme, cycle };
}
