import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

// Hand-built SVG charts (no chart library, desktop dashboard only). Conventions, from the
// data-viz method: thin marks (2px lines, ≤24px bars with 4px rounded data-ends), recessive
// hairline grid, one y-axis only, a legend for ≥2 series, text in text tokens (never the
// series colour), hover AND keyboard readouts, and a table view for every chart. Series
// colours are the validated palette in styles.css (--series-1…4, separate dark/light steps).

export interface Series {
  key: string;
  label: string;
  /** 1–4: the validated categorical slot, in fixed order. */
  slot: 1 | 2 | 3 | 4;
  values: number[];
}

/** Rounds a max up to a clean axis top (1, 2, 2.5, 5 × 10ⁿ steps). */
function niceScale(max: number, ticks = 4): { top: number; step: number } {
  if (max <= 0) return { top: ticks, step: 1 };
  const raw = max / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  return { top: step * ticks, step };
}

function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.floor(entry!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function Legend({ items }: { items: Array<{ label: string; slot: 1 | 2 | 3 | 4; line?: boolean }> }) {
  return (
    <ul className="legend">
      {items.map((i) => (
        <li key={i.label}>
          <span className={`${i.line ? 'key-line' : 'key-box'} s${i.slot}`} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/**
 * Multi-series line chart over time (same unit, one axis). The first series gets a soft area
 * wash. A vertical crosshair snaps to the nearest bucket; the tooltip lists every series.
 */
export function TrendChart(props: {
  labels: string[];
  series: Series[];
  format: (value: number) => string;
  axisFormat: (value: number) => string;
  ariaLabel: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>(640);
  const [active, setActive] = useState<number | null>(null);
  const height = 260;
  const pad = { l: 58, r: 18, t: 14, b: 30 };
  const n = props.labels.length;
  const max = Math.max(0, ...props.series.flatMap((s) => s.values));
  const { top, step } = niceScale(max);
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const x = (i: number) => (n <= 1 ? pad.l + plotW / 2 : pad.l + (i / (n - 1)) * plotW);
  const y = (v: number) => pad.t + (1 - v / top) * plotH;

  const paths = useMemo(
    () =>
      props.series.map((s) => {
        const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
        return {
          ...s,
          line: `M${pts.join('L')}`,
          area: `M${x(0).toFixed(1)},${y(0)}L${pts.join('L')}L${x(n - 1).toFixed(1)},${y(0)}Z`,
        };
      }),
    [props.series, width, top], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));

  function onMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = n <= 1 ? 0 : Math.round(((px - pad.l) / plotW) * (n - 1));
    setActive(Math.min(n - 1, Math.max(0, i)));
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight') setActive((a) => Math.min(n - 1, (a ?? -1) + 1));
    else if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? n) - 1));
    else if (e.key === 'Escape') setActive(null);
  }

  const tipLeft = active === null ? 0 : Math.min(Math.max(x(active) + 12, 8), width - 190);

  return (
    <div className="chart" ref={ref}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={props.ariaLabel}
        tabIndex={0}
        onPointerMove={onMove}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((a) => a ?? n - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        {Array.from({ length: Math.round(top / step) + 1 }, (_, k) => k * step).map((v) => (
          <g key={v}>
            <line className="grid" x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} />
            <text className="tick" x={pad.l - 8} y={y(v)} dy="0.32em" textAnchor="end">
              {props.axisFormat(v)}
            </text>
          </g>
        ))}
        {props.labels.map((label, i) =>
          i % xTickEvery === 0 || i === n - 1 ? (
            <text key={label} className="tick" x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {label}
            </text>
          ) : null,
        )}
        {paths[0] ? <path className={`area s${paths[0].slot}`} d={paths[0].area} /> : null}
        {paths.map((p) => (
          <path key={p.key} className={`line s${p.slot}`} d={p.line} />
        ))}
        {paths.map((p) => (
          <circle key={`${p.key}-end`} className={`dot s${p.slot}`} cx={x(n - 1)} cy={y(p.values[n - 1] ?? 0)} r={4} />
        ))}
        {active !== null ? (
          <g>
            <line className="crosshair" x1={x(active)} x2={x(active)} y1={pad.t} y2={pad.t + plotH} />
            {paths.map((p) => (
              <circle key={`${p.key}-hover`} className={`dot s${p.slot}`} cx={x(active)} cy={y(p.values[active] ?? 0)} r={5} />
            ))}
          </g>
        ) : null}
      </svg>
      {active !== null ? (
        <div className="tooltip" style={{ left: tipLeft, top: 8 }} role="status">
          <div className="tooltip-title">{props.labels[active]}</div>
          {props.series.map((s) => (
            <div key={s.key} className="tooltip-row">
              <span className={`key-line s${s.slot}`} aria-hidden="true" />
              <strong>{props.format(s.values[active] ?? 0)}</strong>
              <span className="muted">{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal bars, one series (one colour), value labelled at every bar's tip. */
export function BarList(props: {
  rows: Array<{ label: string; value: number; sub?: string }>;
  format: (value: number) => string;
  onSelect?: (label: string) => void;
}) {
  const max = Math.max(1, ...props.rows.map((r) => r.value));
  return (
    <ul className="barlist">
      {props.rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${props.format(r.value)}${r.sub ? ` · ${r.sub}` : ''}`}>
          <div className="barlist-head">
            <span className="barlist-label">{r.label}</span>
            <span className="barlist-value">
              <strong>{props.format(r.value)}</strong>
              {r.sub ? <span className="muted"> · {r.sub}</span> : null}
            </span>
          </div>
          <div className="barlist-track">
            <div className="barlist-fill s1" style={{ width: `${Math.max(1.5, (r.value / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Part-to-whole in one horizontal bar (2px gaps between segments) with a legend of values. */
export function StackedBar(props: {
  parts: Array<{ label: string; value: number; slot: 1 | 2 | 3 | 4 }>;
  format: (value: number) => string;
}) {
  const total = props.parts.reduce((s, p) => s + p.value, 0);
  const visible = props.parts.filter((p) => p.value > 0);
  return (
    <div className="stacked">
      <div className="stacked-bar" role="img" aria-label={props.parts.map((p) => `${p.label} ${props.format(p.value)}`).join(', ')}>
        {total === 0 ? <div className="stacked-empty" /> : null}
        {visible.map((p) => (
          <div
            key={p.label}
            className={`stacked-seg s${p.slot}`}
            style={{ flexGrow: p.value }}
            title={`${p.label}: ${props.format(p.value)} (${Math.round((p.value / total) * 100)}%)`}
          />
        ))}
      </div>
      <ul className="legend legend-values">
        {props.parts.map((p) => (
          <li key={p.label}>
            <span className={`key-box s${p.slot}`} aria-hidden="true" />
            <span>{p.label}</span>
            <strong>{props.format(p.value)}</strong>
            <span className="muted">{total > 0 ? `${Math.round((p.value / total) * 100)}%` : '–'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Semicircle meter (like the reference design's speed gauge) for a 0–100 value. */
export function Gauge(props: { value: number | null; label: string; caption?: string }) {
  const v = props.value === null ? 0 : Math.max(0, Math.min(100, props.value));
  const r = 70;
  const cx = 90;
  const cy = 86;
  const arc = (from: number, to: number) => {
    const a0 = Math.PI * (1 - from / 100);
    const a1 = Math.PI * (1 - to / 100);
    return `M${cx + r * Math.cos(a0)},${cy - r * Math.sin(a0)} A${r},${r} 0 0 1 ${cx + r * Math.cos(a1)},${cy - r * Math.sin(a1)}`;
  };
  const needle = Math.PI * (1 - v / 100);
  return (
    <div className="gauge">
      <svg viewBox="0 0 180 104" role="img" aria-label={`${props.label}: ${props.value === null ? 'no data' : `${props.value}%`}`}>
        <path className="gauge-track" d={arc(0, 100)} />
        {v > 0 ? <path className="gauge-fill" d={arc(0, v)} /> : null}
        {[0, 25, 50, 75, 100].map((t) => {
          const a = Math.PI * (1 - t / 100);
          return (
            <line
              key={t}
              className="gauge-tick"
              x1={cx + (r - 16) * Math.cos(a)}
              y1={cy - (r - 16) * Math.sin(a)}
              x2={cx + (r - 22) * Math.cos(a)}
              y2={cy - (r - 22) * Math.sin(a)}
            />
          );
        })}
        <line className="gauge-needle" x1={cx} y1={cy} x2={cx + (r - 28) * Math.cos(needle)} y2={cy - (r - 28) * Math.sin(needle)} />
        <circle className="gauge-hub" cx={cx} cy={cy} r={5} />
      </svg>
      <div className="gauge-value">{props.value === null ? '–' : `${props.value}%`}</div>
      {props.caption ? <div className="muted small">{props.caption}</div> : null}
    </div>
  );
}

/** Tiny trend line for a stat tile (de-emphasised, current point in the accent). */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 32;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 6) + 3, h - 3 - (v / max) * (h - 6)] as const);
  const last = pts[pts.length - 1]!;
  return (
    <svg className="sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.map((p) => p.join(',')).join(' ')} />
      <circle cx={last[0]} cy={last[1]} r={3.5} />
    </svg>
  );
}
