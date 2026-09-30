import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Conventions: money is integer paise (bigint), phones are E.164 text, instants are
// timestamptz (UTC; displayed in IST), calendar dates are IST `date`. No hard deletes:
// see drizzle/0001_guards.sql for the triggers that enforce it.

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------- enums

export const userStatus = pgEnum('user_status', ['active', 'disabled']);
export const factorType = pgEnum('factor_type', ['password', 'pin', 'totp', 'passkey']);
export const sessionKind = pgEnum('session_kind', ['desktop', 'mobile']);
export const loginStage = pgEnum('login_stage', ['password', 'pin', 'unlock', 'step_up', 'recovery']);
export const jobStatus = pgEnum('job_status', ['new', 'assigned', 'in_progress', 'completed', 'cancelled']);
export const recordSource = pgEnum('record_source', ['app', 'imported']);
export const invoiceState = pgEnum('invoice_state', ['submitted', 'issued', 'void', 'rejected']);
export const documentType = pgEnum('document_type', ['invoice']);
export const voidRequestStatus = pgEnum('void_request_status', ['pending', 'approved', 'rejected']);
export const paymentMode = pgEnum('payment_mode', ['cash', 'upi', 'other']);
export const messageAction = pgEnum('message_action', ['issue', 'copy', 'recopy', 'requeue', 'open_chat']);
/** Technician label (owner, Sep 2026): invoice-only, or invoice + assigned work orders. */
export const technicianMode = pgEnum('technician_mode', ['invoice_only', 'invoice_and_work']);

// ---------------------------------------------------------------- identity and auth

export const roles = pgTable('roles', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    roleKey: text('role_key')
      .notNull()
      .references(() => roles.key),
    status: userStatus('status').notNull().default('active'),
    mustChange: boolean('must_change').notNull().default(true),
    /** Technicians only: 'invoice_only' or 'invoice_and_work' (gets the Works assigned tab). */
    technicianMode: technicianMode('technician_mode'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('users_username_lower_uq').on(sql`lower(${t.username})`),
    check('users_technician_mode_ck', sql`(${t.roleKey} = 'technician') = (${t.technicianMode} is not null)`),
  ],
);

/** Pluggable authentication factors: the PIN can later become TOTP or a passkey with no schema change. */
export const authCredentials = pgTable(
  'auth_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    factorType: factorType('factor_type').notNull(),
    secretHash: text('secret_hash').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: createdAt(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('auth_credentials_one_active_pw_pin_uq')
      .on(t.userId, t.factorType)
      .where(sql`${t.revokedAt} is null and ${t.factorType} in ('password', 'pin')`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    kind: sessionKind('kind').notNull(),
    deviceLabel: text('device_label'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastPinAt: timestamp('last_pin_at', { withTimezone: true }).notNull().defaultNow(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    pinFailCount: integer('pin_fail_count').notNull().default(0),
    pinLockedUntil: timestamp('pin_locked_until', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const recoveryCodes = pgTable(
  'recovery_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    createdAt: createdAt(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    usernameAttempted: text('username_attempted').notNull(),
    userId: uuid('user_id').references(() => users.id),
    ip: text('ip'),
    stage: loginStage('stage').notNull(),
    success: boolean('success').notNull(),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
  },
  (t) => [
    index('login_attempts_username_time_idx').on(t.usernameAttempted, t.createdAt),
    index('login_attempts_user_time_idx').on(t.userId, t.createdAt),
    index('login_attempts_ip_time_idx').on(t.ip, t.createdAt),
  ],
);

// ---------------------------------------------------------------- controlled vocabularies

export const areas = pgTable(
  'areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('areas_name_lower_uq').on(sql`lower(${t.name})`)],
);

export const brands = pgTable(
  'brands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    mergedIntoId: uuid('merged_into_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('brands_name_lower_uq').on(sql`lower(${t.name})`)],
);

export const applianceTypes = pgTable(
  'appliance_types',
  {
    key: text('key').primaryKey(),
    label: text('label').notNull(),
    /** Months after the last completed job when a service reminder falls due; null = no reminders. */
    reminderIntervalMonths: smallint('reminder_interval_months'),
    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [check('appliance_types_interval_ck', sql`${t.reminderIntervalMonths} is null or ${t.reminderIntervalMonths} between 1 and 60`)],
);

/** Admin-managed quick-pick chips for the service description field. */
export const servicePresets = pgTable('service_presets', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull().unique(),
  sortOrder: smallint('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- customers and work

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phoneE164: text('phone_e164').notNull().unique(),
    name: text('name').notNull(),
    areaId: uuid('area_id').references(() => areas.id),
    remindersOptOut: boolean('reminders_opt_out').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check('customers_phone_e164_ck', sql`${t.phoneE164} ~ '^\\+[1-9][0-9]{7,14}$'`)],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    applianceTypeKey: text('appliance_type_key')
      .notNull()
      .references(() => applianceTypes.key),
    brandId: uuid('brand_id').references(() => brands.id),
    areaId: uuid('area_id').references(() => areas.id),
    /** What was done. Filled at completion; a work order starts without it. */
    serviceDescription: text('service_description'),
    status: jobStatus('status').notNull().default('new'),
    // Work allocation: a work order is created and assigned by the Master / Admin Technician.
    complaint: text('complaint'),
    visitAddress: text('visit_address'),
    assignedTo: uuid('assigned_to').references(() => users.id),
    assignedBy: uuid('assigned_by').references(() => users.id),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    source: recordSource('source').notNull().default('app'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('jobs_customer_appliance_idx').on(t.customerId, t.applianceTypeKey, t.completedAt),
    index('jobs_assigned_idx').on(t.assignedTo, t.status, t.scheduledAt),
    check('jobs_completed_at_ck', sql`${t.status} <> 'completed' or ${t.completedAt} is not null`),
    check('jobs_completed_service_ck', sql`${t.status} <> 'completed' or ${t.serviceDescription} is not null`),
    check('jobs_assigned_ck', sql`${t.status} not in ('assigned', 'in_progress') or ${t.assignedTo} is not null`),
    check('jobs_cancelled_ck', sql`${t.status} <> 'cancelled' or ${t.cancelledAt} is not null or ${t.assignedTo} is null`),
  ],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    state: invoiceState('state').notNull().default('submitted'),
    documentType: documentType('document_type').notNull().default('invoice'),
    invoiceNumber: integer('invoice_number').unique(),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    invoiceDate: date('invoice_date', { mode: 'string' })
      .notNull()
      .default(sql`(now() at time zone 'Asia/Kolkata')::date`),
    totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
    spareCostPaise: bigint('spare_cost_paise', { mode: 'number' }).notNull().default(0),
    taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
    templateVersion: smallint('template_version'),
    renderedMessage: text('rendered_message'),
    submittedBy: uuid('submitted_by')
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    issuedBy: uuid('issued_by').references(() => users.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    copyCount: integer('copy_count').notNull().default(0),
    lastCopiedBy: uuid('last_copied_by').references(() => users.id),
    lastCopiedAt: timestamp('last_copied_at', { withTimezone: true }),
    requeuedBy: uuid('requeued_by').references(() => users.id),
    requeuedAt: timestamp('requeued_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    rejectedBy: uuid('rejected_by').references(() => users.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedBy: uuid('voided_by').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    backdateReason: text('backdate_reason'),
    editedFlag: boolean('edited_flag').notNull().default(false),
    negativeMarginFlag: boolean('negative_margin_flag').notNull().default(false),
    selfIssuedFlag: boolean('self_issued_flag').notNull().default(false),
    warrantyExpiresAt: date('warranty_expires_at', { mode: 'string' }).generatedAlwaysAs(
      sql`invoice_date + 90`,
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('invoices_state_submitted_idx').on(t.state, t.submittedAt),
    index('invoices_submitted_by_idx').on(t.submittedBy, t.submittedAt),
    index('invoices_job_idx').on(t.jobId),
    check('invoices_total_positive_ck', sql`${t.totalPaise} > 0`),
    check('invoices_spare_nonneg_ck', sql`${t.spareCostPaise} >= 0`),
    check('invoices_tax_nonneg_ck', sql`${t.taxPaise} >= 0`),
    check('invoices_number_range_ck', sql`${t.invoiceNumber} is null or ${t.invoiceNumber} >= 10000`),
    // A number exists exactly when the invoice has been issued (void keeps its number).
    check(
      'invoices_number_state_ck',
      sql`(${t.state} in ('issued', 'void')) = (${t.invoiceNumber} is not null)`,
    ),
    check(
      'invoices_issued_fields_ck',
      sql`${t.state} not in ('issued', 'void') or (${t.renderedMessage} is not null and ${t.templateVersion} is not null and ${t.issuedBy} is not null and ${t.issuedAt} is not null)`,
    ),
    check(
      'invoices_rejected_fields_ck',
      sql`${t.state} <> 'rejected' or (length(trim(coalesce(${t.rejectedReason}, ''))) > 0 and ${t.rejectedBy} is not null and ${t.rejectedAt} is not null)`,
    ),
    check(
      'invoices_void_fields_ck',
      sql`${t.state} <> 'void' or (length(trim(coalesce(${t.voidReason}, ''))) > 0 and ${t.voidedBy} is not null and ${t.voidedAt} is not null)`,
    ),
  ],
);

export const voidRequests = pgTable(
  'void_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    reason: text('reason').notNull(),
    status: voidRequestStatus('status').notNull().default('pending'),
    decidedBy: uuid('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('void_requests_one_pending_uq').on(t.invoiceId).where(sql`${t.status} = 'pending'`),
    check('void_requests_reason_ck', sql`length(trim(${t.reason})) > 0`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    mode: paymentMode('mode').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    collectedByUserId: uuid('collected_by_user_id')
      .notNull()
      .references(() => users.id),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // Roadmap: cash-handover ledger. No UI in the current scope.
    settledToOwnerAt: timestamp('settled_to_owner_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('payments_invoice_idx').on(t.invoiceId),
    check('payments_amount_positive_ck', sql`${t.amountPaise} > 0`),
  ],
);

// ---------------------------------------------------------------- logs, settings, counter

export const messageLog = pgTable(
  'message_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    action: messageAction('action').notNull(),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('message_log_invoice_idx').on(t.invoiceId, t.createdAt)],
);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: updatedAt(),
});

/** Append-only. UPDATE, DELETE and TRUNCATE are blocked by triggers in 0001_guards.sql. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    oldValues: jsonb('old_values'),
    newValues: jsonb('new_values'),
    reason: text('reason'),
    ip: text('ip'),
  },
  (t) => [index('audit_log_entity_idx').on(t.entityType, t.entityId, t.occurredAt)],
);

/**
 * Web Push subscriptions for checkers (Work Inv alerts). Operational data, not business
 * records: expired subscriptions (404/410 from the push service) are deleted.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [index('push_subscriptions_user_idx').on(t.userId)],
);

/** Single-row gapless counter. `start_value` is picked once by the seed and never changes. */
export const invoiceCounter = pgTable(
  'invoice_counter',
  {
    id: smallint('id').primaryKey().default(1),
    startValue: integer('start_value').notNull(),
    nextValue: integer('next_value').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('invoice_counter_single_row_ck', sql`${t.id} = 1`),
    check('invoice_counter_start_range_ck', sql`${t.startValue} between 10000 and 89999`),
    check('invoice_counter_next_ck', sql`${t.nextValue} >= ${t.startValue}`),
  ],
);
