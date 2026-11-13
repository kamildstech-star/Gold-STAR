import { supabase } from "@/integrations/supabase/client";
import { endOfDay, toDateStr, type Range } from "@/lib/period";

/**
 * Performance by office, month to date, against the same span of the previous
 * month and of the same month last year.
 *
 * Money is read from `invoices` and `invoice_payments`, never from
 * `jobs.billed_amount` / `jobs.collected_amount` — those are hand-typed and
 * drift. This is the same source `job-money.ts` derives a single job from, so
 * a location total is the sum of its jobs rather than a second opinion.
 *
 * Nothing here filters by permission or by who may see which office: `jobs`,
 * `invoices` and `invoice_payments` all carry RLS that already answers that,
 * and `invoices_select` additionally requires `job.view_costs`. `locationId`
 * is the app's current-office narrowing, not a security boundary.
 */

export type WindowKey = "current" | "mom" | "yoy";

export type ScorecardWindows = Record<WindowKey, Range>;

export type Bucket = { jobs: number; invoiced: number; collected: number };

export type ScorecardRow = { locationId: string } & Record<WindowKey, Bucket>;

export type LocationScorecard = { windows: ScorecardWindows; rows: ScorecardRow[] };

const WINDOW_KEYS: WindowKey[] = ["current", "mom", "yoy"];

/**
 * Month to date, plus the SAME span one month and one year back.
 *
 * A part-finished month measured against two whole ones is how a good month
 * gets reported as a collapse, so the prior spans are cut at the same day and
 * time of day. Boundaries are built from local getters — `toISOString()` would
 * hand back the UTC day and start the month a day early west of Greenwich.
 * A short prior month clamps to its own last instant instead of rolling into
 * the next one.
 */
export function scorecardWindows(now = new Date()): ScorecardWindows {
  const span = (monthsBack: number): Range => {
    const from = new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
    const lastInstant = endOfDay(new Date(from.getFullYear(), from.getMonth() + 1, 0));
    const sameMoment = new Date(
      from.getFullYear(),
      from.getMonth(),
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    );
    return { from, to: sameMoment > lastInstant ? lastInstant : sameMoment };
  };
  return { current: span(0), mom: span(1), yoy: span(12) };
}

/** Which of the three (disjoint) windows an instant falls in, if any. */
function windowOf(t: number, w: ScorecardWindows): WindowKey | null {
  return WINDOW_KEYS.find((k) => t >= w[k].from.getTime() && t <= w[k].to.getTime()) ?? null;
}

/** One `or=` group per window, so a query reads three months and not a year. */
function orWindows(column: string, w: ScorecardWindows, fmt: (d: Date) => string): string {
  return WINDOW_KEYS.map(
    (k) => `and(${column}.gte.${fmt(w[k].from)},${column}.lte.${fmt(w[k].to)})`,
  ).join(",");
}

const instant = (d: Date) => d.toISOString();

/** A DATE column read at local noon, so no timezone can shift it a day. */
const dayAt = (iso: string) => new Date(`${iso}T12:00:00`).getTime();

const PAGE = 1000;
const MAX_PAGES = 20;

type Page = { data: unknown[] | null; error: { message: string } | null };

/**
 * PostgREST caps a response at a page; taking only the first one would
 * under-count a busy office and look like a quiet month.
 */
async function pageAll<T>(build: (from: number, to: number) => PromiseLike<Page>): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  // Stopping quietly here would report a total that is simply wrong.
  throw new Error("too many records in these months to total in one read");
}

type JobRow = { location_id: string; created_at: string };
type InvoiceRow = { location_id: string; billed_amount: number | null; issue_date: string | null };
type PaymentRow = {
  amount: number | null;
  received_at: string;
  invoices: { location_id: string } | null;
};

export async function fetchLocationScorecard(opts: {
  /** The app's current office, or null for every office the caller can read. */
  locationId: string | null;
  /** False for viewers without `job.view_costs` — their money reads are skipped. */
  includeMoney: boolean;
  windows: ScorecardWindows;
}): Promise<LocationScorecard> {
  const { locationId, includeMoney, windows } = opts;

  const jobs = await pageAll<JobRow>((from, to) => {
    let q = supabase
      .from("jobs")
      .select("location_id,created_at")
      .or(orWindows("created_at", windows, instant))
      .order("id");
    if (locationId) q = q.eq("location_id", locationId);
    return q.range(from, to);
  });

  const [invoices, payments] = includeMoney
    ? await Promise.all([
        pageAll<InvoiceRow>((from, to) => {
          let q = supabase
            .from("invoices")
            .select("location_id,billed_amount,issue_date")
            .or(orWindows("issue_date", windows, toDateStr))
            .order("id");
          if (locationId) q = q.eq("location_id", locationId);
          return q.range(from, to);
        }),
        pageAll<PaymentRow>((from, to) => {
          // Payments carry no office of their own; the invoice they settle does.
          let q = supabase
            .from("invoice_payments")
            .select("amount,received_at,invoices!inner(location_id)")
            .or(orWindows("received_at", windows, instant))
            .order("id");
          if (locationId) q = q.eq("invoices.location_id", locationId);
          return q.range(from, to);
        }),
      ])
    : [[] as InvoiceRow[], [] as PaymentRow[]];

  const byLocation = new Map<string, ScorecardRow>();
  const bucket = (id: string | null | undefined, key: WindowKey | null): Bucket | null => {
    if (!id || !key) return null;
    let row = byLocation.get(id);
    if (!row) {
      row = {
        locationId: id,
        current: { jobs: 0, invoiced: 0, collected: 0 },
        mom: { jobs: 0, invoiced: 0, collected: 0 },
        yoy: { jobs: 0, invoiced: 0, collected: 0 },
      };
      byLocation.set(id, row);
    }
    return row[key];
  };

  for (const j of jobs) {
    const b = bucket(j.location_id, windowOf(new Date(j.created_at).getTime(), windows));
    if (b) b.jobs += 1;
  }
  for (const i of invoices) {
    if (!i.issue_date) continue;
    const b = bucket(i.location_id, windowOf(dayAt(i.issue_date), windows));
    if (b) b.invoiced += Number(i.billed_amount ?? 0);
  }
  for (const p of payments) {
    const b = bucket(p.invoices?.location_id, windowOf(new Date(p.received_at).getTime(), windows));
    if (b) b.collected += Number(p.amount ?? 0);
  }

  return { windows, rows: [...byLocation.values()] };
}
