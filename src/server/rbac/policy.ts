import type { RoleKey, TechnicianMode } from '../../shared/constants.ts';

// The single role → permission matrix. Every route asks `canActor()` (via requirePermission);
// nothing else decides access. Object-level rules (e.g. a technician sees only their own
// submissions and assigned jobs) are applied in queries AND by Postgres row-level security.
export const ACTIONS = [
  'invoice.submit', // create a job + invoice (maker)
  'invoice.view_own', // own submissions and their status
  'invoice.view_all', // every invoice
  'invoice.issue_own', // "Copy invoice" on one's own job, skipping the queue
  'workinv.use', // Technician Work Inv queue: copy, re-copy, put back
  'invoice.edit_pending', // edit a submitted (not yet issued) item
  'invoice.reject', // reject a submitted item with a reason
  'invoice.void', // void directly
  'void.request', // ask the Master to void
  'void.approve', // approve / refuse void requests
  'invoice.backdate', // set an earlier invoice date (reason required)
  'message.view', // see the rendered customer message
  'spare_cost.view', // see spare cost
  'profit.view', // see gross profit / margin
  'snapshot.view', // mobile Business Snapshot
  'analytics.view', // desktop dashboard
  'work.assign', // create, assign, reschedule and cancel work orders
  'work.do', // Works assigned: start and complete jobs assigned to me (per-user label, see below)
  'users.manage', // add, rename, set password/PIN, remove/restore, sign out users
  'settings.manage',
  'audit.view', // audit log and login history
  'export.run',
] as const;

export type Action = (typeof ACTIONS)[number];

const MATRIX: Record<RoleKey, ReadonlySet<Action>> = {
  master: new Set(ACTIONS.filter((a) => a !== 'work.do')),
  // [ASSUMPTION] per spec: no direct void (request only), no users/settings/export/audit/backdate.
  // Owner (Sep 2026): the Admin Technician also assigns work.
  admin_technician: new Set<Action>([
    'invoice.submit',
    'invoice.view_own',
    'invoice.view_all',
    'invoice.issue_own',
    'workinv.use',
    'invoice.edit_pending',
    'invoice.reject',
    'void.request',
    'message.view',
    'spare_cost.view',
    'profit.view',
    'snapshot.view',
    'work.assign',
  ]),
  // Never profit, margin, other technicians' data, the customer message or any WhatsApp link.
  technician: new Set<Action>(['invoice.submit', 'invoice.view_own', 'spare_cost.view']),
};

export function can(role: RoleKey, action: Action): boolean {
  return MATRIX[role]?.has(action) ?? false;
}

/** Role permissions plus per-user labels: "invoice_and_work" technicians also get work.do. */
export function canActor(actor: { roleKey: RoleKey; technicianMode?: TechnicianMode | null }, action: Action): boolean {
  if (action === 'work.do') return actor.roleKey === 'technician' && actor.technicianMode === 'invoice_and_work';
  return can(actor.roleKey, action);
}

export function permissionsFor(role: RoleKey, technicianMode: TechnicianMode | null = null): Action[] {
  return ACTIONS.filter((a) => canActor({ roleKey: role, technicianMode }, a));
}
