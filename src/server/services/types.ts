import type { RoleKey } from '../../shared/constants.ts';

/** The authenticated user performing an action. Built by the auth layer (Phase 3). */
export interface Actor {
  id: string;
  roleKey: RoleKey;
  ip?: string | null;
}
