/**
 * A preset report's own switches, kept in the URL so a filtered report can be
 * bookmarked or sent: `opt=kind:salesman,view:lines`.
 *
 * Mark, 7 Oct: "and reports, it needs to be able to separate salesman and
 * referrers." The commissions report was the first to need a switch of its
 * own; the shape is generic so the next one does not invent another.
 *
 * Pure. An unknown key or a value that is not one of the option's choices is
 * dropped, so a stale link falls back to the defaults instead of an empty
 * report.
 */

import type { ReportOption } from "@/lib/reports-engine";

export function parseReportOptions(
  raw: string | null | undefined,
  options: readonly ReportOption[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const o of options ?? []) out[o.key] = o.choices[0]?.value ?? "";
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [key, value] = part.split(":");
    const o = options?.find((x) => x.key === key);
    if (o && o.choices.some((c) => c.value === value)) out[o.key] = value!;
  }
  return out;
}

/** Back to the URL form; defaults are left out so a plain link stays plain. */
export function formatReportOptions(
  values: Record<string, string>,
  options: readonly ReportOption[] | undefined,
): string | undefined {
  const parts = (options ?? [])
    .filter((o) => values[o.key] && values[o.key] !== o.choices[0]?.value)
    .map((o) => `${o.key}:${values[o.key]}`);
  return parts.length ? parts.join(",") : undefined;
}
