import type { RoleKey } from '../../shared/constants.ts';

// The single role → permission matrix. Every route asks `can()` (via requirePermission);
// nothing else decides access. Object-level rules (e.g. a technician sees only their own
// submissions) are applied in queries AND by Postgres row-level security (drizzle/0003_rls.sql).
export const ACTIONS = [
  'invoice.submit', // create a job + invoice (maker)
  'invoice.view_own', // own submissions and their status
  'invoice.view_all', // every invoice
  'invoice.issue_own', // "Issue & Copy" on one's own job, skipping the queue
  'workinv.use', // Technician Work Inv queue: copy, re-copy, put back, open chat
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
  'users.manage', // rename, reset, disable, revoke sessions
  'settings.manage',
  'audit.view', // audit log and login history
  'export.run',
] as const;

export type Action = (typeof ACTIONS)[number];

const MATRIX: Record<RoleKey, ReadonlySet<Action>> = {
  master: new Set(ACTIONS),
  // [ASSUMPTION] per spec: no direct void (request only), no users/settings/export/audit/backdate.
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
  ]),
  // Never profit, margin, other technicians' data, the customer message or any WhatsApp link.
  technician: new Set<Action>(['invoice.submit', 'invoice.view_own', 'spare_cost.view']),
};

export function can(role: RoleKey, action: Action): boolean {
  return MATRIX[role]?.has(action) ?? false;
}

export function permissionsFor(role: RoleKey): Action[] {
  return ACTIONS.filter((a) => can(role, a));
}
