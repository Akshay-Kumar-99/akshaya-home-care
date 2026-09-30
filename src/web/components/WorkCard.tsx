import type { ReactNode } from 'react';
import type { WorkOrder } from '../../shared/api-types.ts';
import { formatInvoiceNumber } from '../../shared/invoice-template.ts';
import { t } from '../i18n/en.ts';
import { dateTimeIst, formatPhoneForDisplay } from '../lib/format.ts';
import { Icon } from './Icon.tsx';

function statusPill(work: WorkOrder) {
  if (work.status === 'completed' && work.invoice) {
    const inv = work.invoice;
    const label =
      inv.state === 'issued' && inv.invoiceNumber ? `${t.stateLabel.issued} · ${formatInvoiceNumber(inv.invoiceNumber)}` : t.stateLabel[inv.state];
    return <span className={`pill pill-${inv.state}`}>{label}</span>;
  }
  const tone = work.status === 'cancelled' ? 'pill-muted' : work.status === 'in_progress' ? 'pill-submitted' : 'pill-gold';
  return <span className={`pill ${tone}`}>{t.workStatus[work.status]}</span>;
}

/** One work order: the technician's Works assigned and the office's Work orders screens. */
export function WorkCard({ work, office, children }: { work: WorkOrder; office?: boolean; children?: ReactNode }) {
  const sentBack = work.status === 'in_progress' && work.invoice?.state === 'rejected' ? work.invoice.rejectedReason : null;
  return (
    <article className={`card queue-card work-card work-${work.status}`}>
      <div className="queue-card-head">
        <div className="queue-card-who">
          <h3 className="item-title">{work.customerName}</h3>
          <a className="muted small" href={`tel:${work.phone}`}>
            {formatPhoneForDisplay(work.phone)}
          </a>
        </div>
        {statusPill(work)}
      </div>
      <ul className="meta">
        <li>
          <Icon name="wrench" size={16} />
          <span>
            {work.appliance}
            {work.brand ? ` · ${work.brand}` : ''}
            {work.complaint ? ` · ${work.complaint}` : ''}
          </span>
        </li>
        {work.address || work.area ? (
          <li>
            <Icon name="pin" size={16} />
            <span>{[work.address, work.area].filter(Boolean).join(', ')}</span>
          </li>
        ) : null}
        {work.scheduledAt ? (
          <li>
            <Icon name="calendar" size={16} />
            <span>{t.visitAt(dateTimeIst(work.scheduledAt))}</span>
          </li>
        ) : null}
        <li>
          <Icon name="user" size={16} />
          <span>
            {office && work.assignedToName ? `${work.assignedToName} · ` : ''}
            {work.assignedByName ? t.assignedBy(work.assignedByName) : ''}
          </span>
        </li>
      </ul>
      {sentBack ? <p className="reject-note">{t.sentBack(sentBack)}</p> : null}
      {work.status === 'cancelled' && work.cancelReason ? <p className="muted small">{t.cancelledBecause(work.cancelReason)}</p> : null}
      {children}
    </article>
  );
}
