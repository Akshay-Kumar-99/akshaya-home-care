import type pg from 'pg';
import webpush from 'web-push';
import { can } from '../rbac/policy.ts';

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** "mailto:…" or an https URL identifying the sender to push services. */
  subject: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Free Web Push (VAPID) for the Work Inv panel. The payload is a fixed string and carries
 * NO customer data. Push is advisory: the badge poll and the Master's overdue alert work
 * without it. Disabled when VAPID keys are not configured.
 */
export class PushService {
  readonly enabled: boolean;
  readonly publicKey: string | null;
  private readonly pool: pg.Pool;
  private readonly vapid: VapidConfig | null;

  constructor(pool: pg.Pool, vapid: VapidConfig | null) {
    this.pool = pool;
    this.vapid = vapid;
    this.enabled = vapid !== null;
    this.publicKey = vapid?.publicKey ?? null;
  }

  async subscribe(userId: string, sub: PushSubscriptionInput, userAgent: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, failure_count = 0`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent?.slice(0, 300) ?? null],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.pool.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
  }

  /** Fire-and-forget alert to every checker's subscribed devices. Never throws. */
  notifyNewSubmission(): void {
    if (!this.vapid) return;
    this.send({ title: 'Akshaya Home Care', body: 'New invoice waiting', url: '/work-inv' }).catch((err: Error) =>
      console.error('push send failed:', err.message),
    );
  }

  private async send(payload: { title: string; body: string; url: string }): Promise<void> {
    const vapid = this.vapid!;
    const subs = await this.pool.query<{
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      role_key: 'master' | 'admin_technician' | 'technician';
    }>(
      `SELECT s.id, s.endpoint, s.p256dh, s.auth, u.role_key
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE u.status = 'active'`,
    );
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.rows
        .filter((s) => can(s.role_key, 'workinv.use'))
        .map(async (s) => {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
              vapidDetails: vapid,
              TTL: 3600,
              urgency: 'high',
              topic: 'new-invoice',
            });
            await this.pool.query(
              'UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1',
              [s.id],
            );
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await this.pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
            } else {
              await this.pool.query(
                'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1',
                [s.id],
              );
            }
          }
        }),
    );
  }
}
