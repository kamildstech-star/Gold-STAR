import type { Col } from "@/lib/reports-engine";
import { roundMoneyLoose } from "@/lib/money";

/**
 * The totals row a report shows at the top of its table and spreadsheet
 * (David, 21 Oct: "the totals should be on top"). Sums each money and count
 * column — the ones a total means something for — and labels the first
 * column. A column with no number in any row stays blank rather than $0, so
 * an untracked figure is not reported as nothing.
 */
export function reportTotalsRow(
  columns: readonly Col[],
  rows: readonly Record<string, unknown>[],
  label = `Totals (${rows.length})`,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((c, i) => {
    if (i === 0) {
      out[c.key] = label;
      return;
    }
    if (!c.num || !(c.fmt === "usd" || c.fmt === "usd0" || c.fmt === "int")) return;
    let seen = false;
    let sum = 0;
    for (const r of rows) {
      const v = c.get(r);
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v;
        seen = true;
      }
    }
    if (seen) out[c.key] = roundMoneyLoose(sum);
  });
  return out;
}

/**
 * Totals keyed for the columns' own `get` — a column may read a key other
 * than its own (`get: (r) => r.job`), so the row is rebuilt through the
 * column keys: each column reads its value back from `out[c.key]`.
 */
export function totalsColumns(columns: readonly Col[]): Col[] {
  return columns.map((c) => ({ ...c, link: undefined, get: (r) => r[c.key] }));
}
