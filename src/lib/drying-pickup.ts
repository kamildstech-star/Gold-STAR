/**
 * Pure helper for the nightly outside-conditions hook (no client imports).
 * See equipmentPickupDate in drying-log.ts for the per-job cut-off.
 */

/** Jobs that had equipment and have none left on site. */
export function jobsPickedUp(
  placements: readonly { job_id: string | null; retrieved_at: string | null }[],
): Set<string> {
  const placed = new Set<string>();
  const open = new Set<string>();
  for (const p of placements) {
    if (!p.job_id) continue;
    placed.add(p.job_id);
    if (!p.retrieved_at) open.add(p.job_id);
  }
  return new Set([...placed].filter((id) => !open.has(id)));
}
