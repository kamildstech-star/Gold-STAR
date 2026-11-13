import { formatDateUS } from "@/lib/date-format";
import { supabase } from "@/integrations/supabase/client";

/**
 * Per-user, per-table view state. Column choice and filters are personal —
 * an office manager and a rep look at the same table very differently, and
 * neither should have to rebuild their view every morning.
 */
export type TablePrefs = {
  visible?: string[];
  /** Left-to-right column order. Absent means the table's own default order. */
  order?: string[];
  filters?: Record<string, string>;
  group?: string | null;
  sortKey?: string | null;
  sortDir?: "asc" | "desc";
  view?: string;
};

/**
 * `ok: false` is "we could not read your preferences", which is a different
 * fact from `prefs: null`, "you have never saved any". Collapsing the two is
 * how a hand-built layout gets silently reset to the default — and then
 * overwritten with that default by the save that follows. Callers must not
 * persist anything while `ok` is false.
 */
export type TablePrefsRead = { ok: boolean; prefs: TablePrefs | null };

export async function fetchTablePrefs(tableKey: string): Promise<TablePrefsRead> {
  const { data, error } = await supabase
    .from("user_table_prefs")
    .select("prefs")
    .eq("table_key", tableKey)
    .maybeSingle();
  if (error) return { ok: false, prefs: null };
  return { ok: true, prefs: (data?.prefs as TablePrefs | undefined) ?? null };
}

/**
 * A saved column order is a snapshot of the columns that existed the day it
 * was saved, so it is reconciled against today's table rather than trusted:
 *
 *  - a key that no longer exists is dropped, so a deleted column cannot break
 *    or blank the table;
 *  - a column added since lands next to the neighbour it ships beside, not at
 *    the far right. Appending would bury every new column off the end of a
 *    wide table for exactly the people who have customised it most, and they
 *    would report it as "the new column never arrived".
 */
export function mergeColumnOrder<K extends string>(
  available: readonly K[],
  saved: readonly K[] | null | undefined,
): K[] {
  const exists = new Set(available);
  const kept: K[] = [];
  for (const key of saved ?? []) {
    if (exists.has(key) && !kept.includes(key)) kept.push(key);
  }
  if (kept.length === 0) return [...available];

  const placed = new Set(kept);
  const out = [...kept];
  for (let i = 0; i < available.length; i++) {
    const key = available[i]!;
    if (placed.has(key)) continue;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const before = available[j]!;
      if (placed.has(before)) {
        at = out.indexOf(before) + 1;
        break;
      }
    }
    out.splice(at, 0, key);
    placed.add(key);
  }
  return out;
}

export async function saveTablePrefs(tableKey: string, prefs: TablePrefs): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return;
  await supabase
    .from("user_table_prefs")
    .upsert(
      { user_id: uid, table_key: tableKey, prefs: prefs as never },
      { onConflict: "user_id,table_key" },
    );
}

/** Days between now and an ISO timestamp. Negative = in the future. */
export function daysAgo(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * A bare `YYYY-MM-DD` from a `date` column parses as UTC midnight, which is the
 * previous day for anyone west of Greenwich. Anchor it to local midnight so a
 * date of loss reads the same here as it does on the Jobs list.
 */
export function fmtDate(ts: string | null | undefined): string {
  if (!ts) return "—";
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(ts) ? `${ts}T00:00:00` : ts;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return formatDateUS(d);
}

/**
 * Dollars, not cents. The money columns this formats — jobs.billed_amount,
 * approved_amount, estimated_amount, invoices.billed_amount — are all
 * numeric(12,2) in dollars. Dividing by 100 here rendered a $94,250 job as
 * $943 on Active Clients while the Jobs list showed it correctly.
 *
 * Locale is pinned so the same figure does not render "1.234 $" here and
 * "$1,234" in the job header on the same screen.
 */
export function fmtMoney(dollars: number | null | undefined): string {
  if (dollars == null) return "—";
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function toCsv(headers: string[], rows: (string | number | null)[][]): string {
  const esc = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n");
}

export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
