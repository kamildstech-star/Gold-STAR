/**
 * Keep client-side read-only modes honest even if a stale or scripted event
 * reaches a mutation after its control has been disabled.
 */
export function assertWritesEnabled(disabled: boolean, reason?: string | null): void {
  if (disabled) {
    throw new Error(reason ?? "Writes are disabled in this view.");
  }
}
