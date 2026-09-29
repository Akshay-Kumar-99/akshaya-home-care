import { useEffect, useId, useMemo, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { t } from '../i18n/en.ts';
import { useTheme } from '../lib/theme.ts';
import { Icon, type IconName } from './Icon.tsx';

/** Bottom sheet on phones, centred modal on desktop. Escape or backdrop closes. */
export function Dialog(props: { title: string; children: ReactNode; onClose?: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.dialog-close)');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose?.();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && props.onClose?.()}>
      <div className={`dialog${props.wide ? ' dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <div className="dialog-handle" aria-hidden="true" />
        <div className="dialog-head">
          <h2 className="dialog-title">{props.title}</h2>
          {props.onClose ? (
            <button type="button" className="icon-btn dialog-close" aria-label={t.close} onClick={props.onClose}>
              <Icon name="x" />
            </button>
          ) : null}
        </div>
        {props.children}
      </div>
    </div>
  );
}

export function Field(props: { label: string; error?: string | null; hint?: string; icon?: IconName; children: ReactNode }) {
  return (
    <label className={`field${props.error ? ' field-invalid' : ''}`}>
      <span className="field-label">{props.label}</span>
      <span className={props.icon ? 'input-wrap has-icon' : 'input-wrap'}>
        {props.icon ? <Icon name={props.icon} size={18} className="input-icon" /> : null}
        {props.children}
      </span>
      {props.hint && !props.error ? <span className="field-hint">{props.hint}</span> : null}
      {props.error ? (
        <span className="field-error" role="alert">
          <Icon name="alert" size={14} /> {props.error}
        </span>
      ) : null}
    </label>
  );
}

export function Section(props: { title: string; icon: IconName; children: ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">
        <Icon name={props.icon} size={16} /> {props.title}
      </h3>
      <div className="section-body">{props.children}</div>
    </section>
  );
}

export function Chips<T extends string>(props: {
  label: string;
  options: Array<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  error?: string | null;
  segmented?: boolean;
}) {
  const id = useId();
  return (
    <div className={`field${props.error ? ' field-invalid' : ''}`} role="radiogroup" aria-labelledby={id}>
      <span className="field-label" id={id}>
        {props.label}
      </span>
      <div className={props.segmented ? 'segmented' : 'chips'}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={props.value === o.value}
            className={`chip${props.value === o.value ? ' chip-on' : ''}`}
            onClick={() => props.onChange(o.value)}
          >
            {props.value === o.value ? <Icon name="check" size={16} /> : null}
            {o.label}
          </button>
        ))}
      </div>
      {props.error ? (
        <span className="field-error" role="alert">
          <Icon name="alert" size={14} /> {props.error}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Type-to-filter picker for controlled lists (areas, brands). Works the same on Android and
 * iPhone (the native <datalist> is unreliable on iOS). Matches starting with the typed text
 * come first; the parent validates that the final text is a listed value.
 */
export function Combobox(props: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  icon?: IconName;
  error?: string | null;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const blurTimer = useRef<number | undefined>(undefined);

  const matches = useMemo(() => {
    const q = props.value.trim().toLowerCase();
    if (!q) return props.options.slice(0, 8);
    const starts = props.options.filter((o) => o.toLowerCase().startsWith(q));
    const contains = props.options.filter((o) => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
    return [...starts, ...contains].slice(0, 8);
  }, [props.value, props.options]);

  const exact = props.options.some((o) => o.toLowerCase() === props.value.trim().toLowerCase());

  function choose(value: string) {
    props.onChange(value);
    setOpen(false);
  }

  return (
    <div className={`field combobox${props.error ? ' field-invalid' : ''}`}>
      <label className="field-label" htmlFor={`${listId}-input`}>
        {props.label}
      </label>
      <span className={props.icon ? 'input-wrap has-icon' : 'input-wrap'}>
        {props.icon ? <Icon name={props.icon} size={18} className="input-icon" /> : null}
        <input
          id={`${listId}-input`}
          role="combobox"
          aria-expanded={open && matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={props.placeholder}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = window.setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && open && matches[active]) {
              e.preventDefault();
              choose(matches[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {exact ? <Icon name="check" size={18} className="input-ok" /> : null}
      </span>
      {open && matches.length > 0 && !exact ? (
        <ul className="combo-list" id={listId} role="listbox">
          {matches.map((m, i) => (
            <li
              key={m}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'combo-option combo-active' : 'combo-option'}
              onMouseDown={(e) => {
                e.preventDefault();
                window.clearTimeout(blurTimer.current);
                choose(m);
              }}
            >
              {m}
            </li>
          ))}
        </ul>
      ) : null}
      {props.error ? (
        <span className="field-error" role="alert">
          <Icon name="alert" size={14} /> {props.error}
        </span>
      ) : null}
    </div>
  );
}

/** Whole-rupee amount with a ₹ prefix and the Indian-format value shown underneath. */
export function MoneyInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
}) {
  return (
    <label className={`field${props.error ? ' field-invalid' : ''}`}>
      <span className="field-label">{props.label}</span>
      <span className="input-wrap money">
        <span className="money-prefix" aria-hidden="true">
          ₹
        </span>
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value.replace(/[^\d]/g, ''))}
        />
      </span>
      {props.hint && !props.error ? <span className="field-hint">{props.hint}</span> : null}
      {props.error ? (
        <span className="field-error" role="alert">
          <Icon name="alert" size={14} /> {props.error}
        </span>
      ) : null}
    </label>
  );
}

/** Password (or PIN) input with a show/hide eye, so long generated passwords can be checked. */
export function SecretInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const [shown, setShown] = useState(false);
  return (
    <>
      <input {...props} type={shown ? 'text' : 'password'} />
      <button
        type="button"
        className="icon-btn input-eye"
        aria-label={shown ? t.hide : t.show}
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
      >
        <Icon name={shown ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label={t.loading}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton-line" />
      ))}
    </div>
  );
}

export function EmptyState(props: { icon: IconName; title: string; text?: string }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={props.icon} size={28} />
      </span>
      <strong>{props.title}</strong>
      {props.text ? <span className="muted">{props.text}</span> : null}
    </div>
  );
}

export function Initials({ name }: { name: string }) {
  // Letters only: "Meena 6464" → "M", "Ravi Kumar" → "RK".
  const letters = name
    .split(/\s+/)
    .filter((w) => /^\p{L}/u.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className="avatar" aria-hidden="true">
      {letters || '?'}
    </span>
  );
}

export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const label = theme === 'auto' ? t.themeAuto : theme === 'dark' ? t.themeDark : t.themeLight;
  return (
    <button type="button" className="icon-btn" onClick={cycle} aria-label={label} title={label}>
      <Icon name={theme === 'auto' ? 'auto' : theme === 'dark' ? 'moon' : 'sun'} />
    </button>
  );
}
