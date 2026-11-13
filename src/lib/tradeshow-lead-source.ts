/**
 * The admin-managed "Tradeshow" lead source, by label or key, if there is one.
 * Pure, so the server-side booth submission and the tablet capture resolve the
 * same option the same way.
 */
export function findTradeshowLeadSourceId(
  options: { id: string; key: string; label: string }[],
): string | null {
  const hit = options.find((o) => /trade\s*-?\s*show/i.test(`${o.key} ${o.label}`));
  return hit?.id ?? null;
}
