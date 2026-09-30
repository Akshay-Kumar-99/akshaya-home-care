import type { RoleKey, TechnicianMode } from '../../shared/constants.ts';

/** The authenticated user performing an action. Built by the auth layer (Phase 3). */
export interface Actor {
  id: string;
  roleKey: RoleKey;
  /** Technicians only: invoice-only or invoice + work allocation. */
  technicianMode?: TechnicianMode | null;
  ip?: string | null;
}
