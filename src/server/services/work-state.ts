/**
 * In-process "has my work list changed?" counter per technician, for the Works assigned badge
 * poll. Every assign / re-assign / reschedule / cancel / complete calls `changed(techId)`, so
 * polls between changes are answered from memory with no database query (Neon can sleep).
 * After a restart the counters start again from a new random base, so every client sees a
 * change once and reloads.
 */
export class WorkState {
  private readonly versions = new Map<string, number>();
  private readonly base = Math.floor(Math.random() * 1_000_000);

  version(userId: string): number {
    return this.base + (this.versions.get(userId) ?? 0);
  }

  changed(...userIds: Array<string | null | undefined>): void {
    for (const id of userIds) {
      if (id) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    }
  }
}
