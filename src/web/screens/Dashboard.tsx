import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AnalyticsOverview, CustomerHistory } from '../../shared/api-types.ts';
import { istDateString } from '../../shared/dates.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { BarList, Gauge, Legend, Sparkline, StackedBar, TrendChart } from '../components/charts.tsx';
import { Icon } from '../components/Icon.tsx';
import { Dialog, EmptyState, Initials, Skeleton } from '../components/ui.tsx';
import { t } from '../i18n/en.ts';
import { api } from '../lib/api.ts';
import {
  bucketLabel,
  formatDateDmy,
  formatInr,
  formatPhoneForDisplay,
  inrCompact,
  inrWhole,
  pctChange,
} from '../lib/format.ts';

// Master analytics dashboard (desktop shell only; lazy chunk). One date-range filter above
// everything; every tile, chart and table re-renders against the same range. While a new
// range loads, the previous render stays on screen, dimmed: no skeleton flash.

type PresetKey = 'today' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'thisFy' | 'lastFy';

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'today', label: t.rangeToday },
  { key: '7d', label: t.range7d },
  { key: '30d', label: t.range30d },
  { key: 'thisMonth', label: t.rangeThisMonth },
  { key: 'lastMonth', label: t.rangeLastMonth },
  { key: 'thisFy', label: t.rangeThisFy },
  { key: 'lastFy', label: t.rangeLastFy },
];

const RANGE_KEY = 'ahc.dashboard.range';

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Date range for a preset, in IST calendar dates. The Indian FY runs April–March. */
export function presetRange(key: PresetKey, todayIso = istDateString()): { from: string; to: string } {
  const today = new Date(`${todayIso}T00:00:00Z`);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const days = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));
  const fyStartYear = m >= 3 ? y : y - 1;
  switch (key) {
    case 'today':
      return { from: todayIso, to: todayIso };
    case '7d':
      return { from: days(6), to: todayIso };
    case '30d':
      return { from: days(29), to: todayIso };
    case 'thisMonth':
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: todayIso };
    case 'lastMonth':
      return { from: iso(new Date(Date.UTC(y, m - 1, 1))), to: iso(new Date(Date.UTC(y, m, 0))) };
    case 'thisFy':
      return { from: `${fyStartYear}-04-01`, to: todayIso };
    case 'lastFy':
      return { from: `${fyStartYear - 1}-04-01`, to: `${fyStartYear}-03-31` };
  }
}

function readPreset(): PresetKey {
  try {
    const v = localStorage.getItem(RANGE_KEY) as PresetKey | null;
    return v && PRESETS.some((p) => p.key === v) ? v : '30d';
  } catch {
    return '30d';
  }
}

export function Dashboard() {
  const [preset, setPreset] = useState<PresetKey>(readPreset);
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [customer, setCustomer] = useState<string | null>(null);
  const [trendTable, setTrendTable] = useState(false);

  const load = useCallback(async (key: PresetKey) => {
    const { from, to } = presetRange(key);
    setLoading(true);
    try {
      setData(await api<AnalyticsOverview>(`/api/analytics/overview?from=${from}&to=${to}`));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(preset);
    try {
      localStorage.setItem(RANGE_KEY, preset);
    } catch {
      // not persisted
    }
  }, [preset, load]);

  const presetLabel = PRESETS.find((p) => p.key === preset)!.label;

  return (
    <section className="page dashboard">
      <header className="page-head">
        <div>
          <h2 className="page-title">{t.dashboardTitle}</h2>
          <p className="page-sub">
            {data ? `${formatDateDmy(data.range.from)} – ${formatDateDmy(data.range.to)} · ${t.dashboardSub}` : t.dashboardSub}
          </p>
        </div>
        <RangePicker value={preset} label={presetLabel} onChange={setPreset} />
      </header>

      {error ? (
        <p className="form-error">
          <Icon name="wifiOff" size={18} /> <span>{t.serverUnreachable}</span>
        </p>
      ) : null}
      {!data && loading ? <Skeleton lines={12} /> : null}
      {data ? (
        <div className={`dash-body${loading ? ' is-refreshing' : ''}`} aria-busy={loading}>
          <Kpis data={data} />
          <div className="dash-grid">
            <Card
              className="span-2"
              title={t.chartSalesExpense}
              sub={t.chartSalesExpenseSub(t.granularity[data.range.granularity] ?? '')}
              action={
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setTrendTable((v) => !v)} aria-pressed={trendTable}>
                  <Icon name={trendTable ? 'receipt' : 'list'} size={16} />
                  {trendTable ? t.viewChart : t.viewTable}
                </button>
              }
            >
              {trendTable ? <TrendTable data={data} /> : <SalesTrend data={data} />}
            </Card>

            <Card title={t.chartMargin} sub={t.chartMarginSub}>
              <Gauge value={data.kpis.marginPct} label={t.chartMargin} caption={`${inrWhole(data.kpis.grossProfitPaise)} ${t.grossProfitOn} ${inrWhole(data.kpis.revenuePaise)}`} />
            </Card>

            <Card title={t.chartByArea} sub={t.chartByAreaSub}>
              {data.byArea.length === 0 ? (
                <EmptyState icon="pin" title={t.noDataInRange} />
              ) : (
                <BarList
                  rows={data.byArea.map((a) => ({ label: a.area, value: a.revenuePaise, sub: t.jobsCount(a.invoices) }))}
                  format={inrWhole}
                />
              )}
            </Card>

            <Card title={t.chartTopCustomers} sub={t.chartTopCustomersSub} className="span-2">
              <TopCustomers data={data} onOpen={setCustomer} />
            </Card>

            <Card title={t.chartPayments} sub={t.chartPaymentsSub}>
              <StackedBar
                format={inrWhole}
                parts={[
                  { label: t.paidCash, value: data.paymentMix.cashPaise, slot: 1 },
                  { label: t.paidUpi, value: data.paymentMix.upiPaise, slot: 2 },
                  { label: t.paidOther, value: data.paymentMix.otherPaise, slot: 3 },
                  { label: t.notPaid, value: data.paymentMix.unpaidPaise, slot: 4 },
                ]}
              />
            </Card>

            <Card title={t.chartByAppliance} sub={t.chartByApplianceSub}>
              {data.byAppliance.length === 0 ? (
                <EmptyState icon="wrench" title={t.noDataInRange} />
              ) : (
                <BarList
                  rows={data.byAppliance.map((a) => ({ label: a.appliance, value: a.revenuePaise, sub: t.jobsCount(a.invoices) }))}
                  format={inrWhole}
                />
              )}
            </Card>

            <Card title={t.chartTeam} sub={t.chartTeamSub} className="span-2">
              <TeamTable data={data} />
            </Card>

            <Card title={t.chartQuality} sub={t.chartQualitySub}>
              <Quality data={data} />
            </Card>
          </div>
        </div>
      ) : null}

      {customer ? <CustomerDialog phone={customer} onClose={() => setCustomer(null)} /> : null}
    </section>
  );
}

function Card(props: { title: string; sub?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <article className={`dash-card${props.className ? ` ${props.className}` : ''}`}>
      <header className="dash-card-head">
        <div>
          <h3>{props.title}</h3>
          {props.sub ? <p className="muted small">{props.sub}</p> : null}
        </div>
        {props.action}
      </header>
      {props.children}
    </article>
  );
}

/** Date-range presets as rows; selection marked with a check. */
function RangePicker(props: { value: PresetKey; label: string; onChange: (key: PresetKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="range-picker" ref={ref}>
      <button type="button" className="btn btn-small range-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="clock" size={16} />
        {props.label}
        <Icon name="chevronDown" size={16} />
      </button>
      {open ? (
        <ul className="range-menu" role="listbox" aria-label={t.dateRange}>
          {PRESETS.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                role="option"
                aria-selected={p.key === props.value}
                className="range-option"
                onClick={() => {
                  props.onChange(p.key);
                  setOpen(false);
                }}
              >
                <span className="range-check">{p.key === props.value ? <Icon name="check" size={16} /> : null}</span>
                {p.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Delta({ current, previous, upIsGood }: { current: number; previous: number; upIsGood: boolean | null }) {
  const change = pctChange(current, previous);
  if (change === null) return <span className="delta delta-flat">{current > 0 ? t.deltaNew : t.deltaNone}</span>;
  const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
  const tone = upIsGood === null || direction === 'flat' ? 'flat' : (direction === 'up') === upIsGood ? 'good' : 'bad';
  return (
    <span className={`delta delta-${tone}`} title={t.vsPrevious}>
      {direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■'} {Math.abs(change)}%
    </span>
  );
}

function Kpis({ data }: { data: AnalyticsOverview }) {
  const k = data.kpis;
  const p = data.previous;
  return (
    <>
      <div className="kpi-row">
        <div className="kpi kpi-hero">
          <span className="kpi-label">
            <Icon name="receipt" size={16} /> {t.kpiSales}
          </span>
          <strong className="kpi-value">{inrWhole(k.revenuePaise)}</strong>
          <div className="kpi-foot">
            <Delta current={k.revenuePaise} previous={p.revenuePaise} upIsGood />
            <Sparkline values={data.trend.map((b) => b.revenuePaise)} />
          </div>
        </div>
        <div className="kpi">
          <span className="kpi-label">
            <Icon name="wrench" size={16} /> {t.kpiExpense}
          </span>
          <strong className="kpi-value">{inrWhole(k.expensePaise)}</strong>
          <div className="kpi-foot">
            <Delta current={k.expensePaise} previous={p.expensePaise} upIsGood={null} />
            <span className="muted small">{t.kpiExpenseHint}</span>
          </div>
        </div>
        <div className="kpi">
          <span className="kpi-label">
            <Icon name="checkCircle" size={16} /> {t.kpiProfit}
          </span>
          <strong className="kpi-value">{inrWhole(k.grossProfitPaise)}</strong>
          <div className="kpi-foot">
            <Delta current={k.grossProfitPaise} previous={p.grossProfitPaise} upIsGood />
            <span className="muted small">{k.marginPct === null ? '' : t.marginOf(k.marginPct)}</span>
          </div>
        </div>
      </div>
      <div className="chip-row" role="list">
        <Chip icon="receipt" label={t.kpiInvoices} value={String(k.invoices)} />
        <Chip icon="copy" label={t.kpiAvgTicket} value={k.avgTicketPaise === null ? '–' : inrWhole(k.avgTicketPaise)} />
        <Chip icon="user" label={t.kpiCustomers} value={String(k.customers)} hint={k.repeatCustomerPct === null ? undefined : t.repeatPct(k.repeatCustomerPct)} />
        <Chip icon="alert" label={t.kpiOutstanding} value={inrWhole(k.outstandingPaise)} warn={k.outstandingPaise > 0} />
        <Chip icon="clock" label={t.kpiPipeline} value={`${k.pendingCount} · ${inrCompact(k.pendingPaise)}`} />
      </div>
    </>
  );
}

function Chip(props: { icon: 'receipt' | 'copy' | 'user' | 'alert' | 'clock'; label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className={`stat-chip${props.warn ? ' stat-chip-warn' : ''}`} role="listitem">
      <Icon name={props.icon} size={16} />
      <span className="muted">{props.label}</span>
      <strong>{props.value}</strong>
      {props.hint ? <span className="muted small">{props.hint}</span> : null}
    </div>
  );
}

function SalesTrend({ data }: { data: AnalyticsOverview }) {
  const labels = data.trend.map((b) => bucketLabel(b.bucket, data.range.granularity));
  if (data.trend.every((b) => b.revenuePaise === 0 && b.expensePaise === 0)) {
    return <EmptyState icon="receipt" title={t.noDataInRange} />;
  }
  return (
    <>
      <Legend
        items={[
          { label: t.kpiSales, slot: 1, line: true },
          { label: t.kpiExpense, slot: 2, line: true },
        ]}
      />
      <TrendChart
        ariaLabel={t.chartSalesExpense}
        labels={labels}
        format={inrWhole}
        axisFormat={inrCompact}
        series={[
          { key: 'sales', label: t.kpiSales, slot: 1, values: data.trend.map((b) => b.revenuePaise) },
          { key: 'expense', label: t.kpiExpense, slot: 2, values: data.trend.map((b) => b.expensePaise) },
        ]}
      />
    </>
  );
}

function TrendTable({ data }: { data: AnalyticsOverview }) {
  return (
    <div className="table-wrap flat">
      <table className="table dash-table">
        <thead>
          <tr>
            <th>{t.period}</th>
            <th className="num">{t.kpiSales}</th>
            <th className="num">{t.kpiExpense}</th>
            <th className="num">{t.kpiProfit}</th>
            <th className="num">{t.kpiInvoices}</th>
          </tr>
        </thead>
        <tbody>
          {data.trend.map((b) => (
            <tr key={b.bucket}>
              <td data-label={t.period}>{bucketLabel(b.bucket, data.range.granularity)}</td>
              <td data-label={t.kpiSales} className="num">{inrWhole(b.revenuePaise)}</td>
              <td data-label={t.kpiExpense} className="num">{inrWhole(b.expensePaise)}</td>
              <td data-label={t.kpiProfit} className="num">{inrWhole(b.revenuePaise - b.expensePaise)}</td>
              <td data-label={t.kpiInvoices} className="num">{b.invoices}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopCustomers({ data, onOpen }: { data: AnalyticsOverview; onOpen: (phone: string) => void }) {
  if (data.byCustomer.length === 0) return <EmptyState icon="user" title={t.noDataInRange} />;
  const max = Math.max(1, ...data.byCustomer.map((c) => c.revenuePaise));
  return (
    <div className="table-wrap flat">
      <table className="table dash-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t.customer}</th>
            <th>{t.area}</th>
            <th className="num">{t.kpiInvoices}</th>
            <th>{t.kpiSales}</th>
            <th className="num">{t.kpiProfit}</th>
            <th>{t.lastVisit}</th>
          </tr>
        </thead>
        <tbody>
          {data.byCustomer.map((c, i) => (
            <tr key={c.phone} onClick={() => onOpen(c.phone)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(c.phone)}>
              <td data-label="#" className="muted">{i + 1}</td>
              <td data-label={t.customer}>
                <div className="who">
                  <Initials name={c.name} />
                  <div>
                    <strong>{c.name}</strong>
                    <div className="muted small">{formatPhoneForDisplay(c.phone)}</div>
                  </div>
                </div>
              </td>
              <td data-label={t.area}>{c.area ?? '–'}</td>
              <td data-label={t.kpiInvoices} className="num">{c.invoices}</td>
              <td data-label={t.kpiSales}>
                <div className="share">
                  <strong className="amount">{inrWhole(c.revenuePaise)}</strong>
                  <span className="share-track" aria-hidden="true">
                    <span className="share-fill s1" style={{ width: `${(c.revenuePaise / max) * 100}%` }} />
                  </span>
                </div>
              </td>
              <td data-label={t.kpiProfit} className={`num ${c.grossProfitPaise < 0 ? 'neg' : ''}`}>{inrWhole(c.grossProfitPaise)}</td>
              <td data-label={t.lastVisit}>{formatDateDmy(c.lastInvoiceDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TeamTable({ data }: { data: AnalyticsOverview }) {
  if (data.byTechnician.length === 0) return <EmptyState icon="user" title={t.noDataInRange} />;
  const pctText = (v: number | null) => (v === null ? '–' : `${v}%`);
  return (
    <div className="table-wrap flat">
      <table className="table dash-table">
        <thead>
          <tr>
            <th>{t.technician}</th>
            <th className="num">{t.kpiInvoices}</th>
            <th className="num">{t.kpiSales}</th>
            <th className="num">{t.kpiAvgTicket}</th>
            <th className="num">{t.editedRate}</th>
            <th className="num">{t.rejectedRate}</th>
            <th className="num">{t.timeToIssue}</th>
          </tr>
        </thead>
        <tbody>
          {data.byTechnician.map((row) => (
            <tr key={row.name}>
              <td data-label={t.technician}>
                <div className="who">
                  <Initials name={row.name} />
                  <div>
                    <strong>{row.name}</strong>
                    <div className="muted small">{t.roleLabel[row.role]}</div>
                  </div>
                </div>
              </td>
              <td data-label={t.kpiInvoices} className="num">{row.invoices}</td>
              <td data-label={t.kpiSales} className="num strong">{inrWhole(row.revenuePaise)}</td>
              <td data-label={t.kpiAvgTicket} className="num">{row.avgTicketPaise === null ? '–' : inrWhole(row.avgTicketPaise)}</td>
              <td data-label={t.editedRate} className="num">{pctText(row.editedPct)}</td>
              <td data-label={t.rejectedRate} className={`num ${row.rejectedPct && row.rejectedPct > 10 ? 'neg' : ''}`}>{pctText(row.rejectedPct)}</td>
              <td data-label={t.timeToIssue} className="num">{row.avgMinutesToIssue === null ? '–' : t.minutesShort(row.avgMinutesToIssue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Quality({ data }: { data: AnalyticsOverview }) {
  const q = data.quality;
  const rows: Array<{ icon: 'undo' | 'copy' | 'alert' | 'ban' | 'x'; label: string; value: string; warn?: boolean }> = [
    {
      icon: 'undo',
      label: t.qualityCallbacks,
      value: `${q.warrantyCallbacks}${q.warrantyCallbackPct === null ? '' : ` · ${q.warrantyCallbackPct}%`}`,
      warn: q.warrantyCallbacks > 0,
    },
    { icon: 'copy', label: t.qualitySelfIssued, value: q.selfIssuedPct === null ? '–' : `${q.selfIssuedPct}%` },
    { icon: 'alert', label: t.negativeMargin, value: String(q.negativeMarginCount), warn: q.negativeMarginCount > 0 },
    { icon: 'ban', label: t.qualityVoided, value: String(q.voided), warn: q.voided > 0 },
    { icon: 'x', label: t.qualityRejected, value: String(q.rejected) },
  ];
  return (
    <ul className="quality">
      {rows.map((r) => (
        <li key={r.label} className={r.warn ? 'quality-warn' : undefined}>
          <Icon name={r.icon} size={18} />
          <span>{r.label}</span>
          <strong>{r.value}</strong>
        </li>
      ))}
    </ul>
  );
}

function CustomerDialog({ phone, onClose }: { phone: string; onClose: () => void }) {
  const [history, setHistory] = useState<CustomerHistory | null>(null);
  useEffect(() => {
    api<CustomerHistory>(`/api/analytics/customer?phone=${encodeURIComponent(phone)}`)
      .then(setHistory)
      .catch(onClose);
  }, [phone]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = useMemo(() => istDateString(), []);

  return (
    <Dialog title={history?.name ?? t.customer} onClose={onClose} wide>
      {!history ? (
        <Skeleton lines={6} />
      ) : (
        <div className="stack">
          <div className="row">
            <span className="pill pill-muted">
              <Icon name="phone" size={14} />
              {formatPhoneForDisplay(history.phone)}
            </span>
            {history.area ? (
              <span className="pill pill-muted">
                <Icon name="pin" size={14} />
                {history.area}
              </span>
            ) : null}
          </div>
          <div className="money-strip">
            <div>
              <span className="muted small">{t.lifetimeSales}</span>
              <strong className="amount amount-lg">{inrWhole(history.lifetimeRevenuePaise)}</strong>
            </div>
            <div>
              <span className="muted small">{t.kpiInvoices}</span>
              <strong className="amount">{history.lifetimeInvoices}</strong>
            </div>
            <div>
              <span className="muted small">{t.customerSince}</span>
              <strong className="amount">{history.firstInvoiceDate ? formatDateDmy(history.firstInvoiceDate) : '–'}</strong>
            </div>
          </div>
          <ul className="history-list">
            {history.invoices.map((inv) => (
              <li key={inv.id}>
                <span className={`pill pill-${inv.state}`}>
                  {inv.invoiceNumber ? formatInvoiceNumber(inv.invoiceNumber) : t.stateLabel[inv.state]}
                </span>
                <div className="grow">
                  <strong>{inv.appliance}</strong> · {inv.serviceDescription}
                  <div className="muted small">
                    {formatDateDmy(inv.invoiceDate)}
                    {inv.state === 'issued' && inv.warrantyExpiresAt >= today ? ` · ${t.underWarranty(formatDateDmy(inv.warrantyExpiresAt))}` : ''}
                  </div>
                </div>
                <strong className="amount">{formatInr(inv.totalPaise)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
