-- Owner decision (29 Sep 2026): technicians sign in with username + password only.
-- Revoke any PIN already stored for a technician (e.g. from an earlier seed). Nothing is
-- deleted: rows are marked revoked, as with every credential change.
UPDATE auth_credentials
SET revoked_at = now()
WHERE factor_type = 'pin'
  AND revoked_at IS NULL
  AND user_id IN (SELECT id FROM users WHERE role_key = 'technician');
--> statement-breakpoint

INSERT INTO audit_log (actor_id, action, entity_type, entity_id, reason)
SELECT NULL, 'user.pin_removed', 'user', u.id::text, 'Technicians no longer use a PIN (migration 0004)'
FROM users u
WHERE u.role_key = 'technician';
