import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import {
  LedgerEditableCell,
  LedgerTotalCell,
  ledgerCellTitle,
  useLedgerEditing,
} from "@/components/job-ledger-cell";
import { supabase } from "@/integrations/supabase/client";
import { dailySuppliesCharge } from "@/lib/supply-fee-schedule";
import { loadLedgerEffort } from "@/lib/invoice-ledger-pull";
import {
  canEditLedger,
  billingRowsWithOverrides,
  effortRowsWithOverrides,
  isLedgerEditable,
  LEDGER_CELL_SOURCES,
  ledgerRowsWithOverrides,
  ledgerStripCells,
  type LedgerRow,
} from "@/lib/job-ledger";
import { LEDGER_OVERRIDES_KEY, fetchLedgerOverrides } from "@/lib/job-ledger-overrides";
import { stripFade } from "@/lib/job-tab-order";
import { isMissingSchema } from "@/lib/schema-fallback";
import { useJobCommission } from "@/lib/use-job-commission";
import { useRefreshTmDerivedOnSync } from "@/lib/tm-derived";
import { cn } from "@/lib/utils";

/**
 * Everything the ledger reads, and the rows it builds from it — one hook, so
 * the ledger strip atop the Billing tab and the Commissions card in its rail
 * are the same queries (shared through the query cache, fetched once) and the
 * same `jobLedgerRows`. David, 22 Sep, asked for the strip; a second way of
 * adding the job up for it is what this exists to prevent.
 *
 * `money: false` is a viewer without `job.view_costs`: the cost, invoice and
 * commission reads are not made at all, and only the effort rows come back.
 */
export function useJobLedger(
  jobId: string,
  opts: { money: boolean; billing?: boolean } = { money: true },
) {
  const money = opts.money;
  // Billed / Paid without cost (job.view_billing) — T11.
  const billing = money || opts.billing === true;
  /*
   * The running cost and the commission come from ONE hook, the one the
   * Commissions card reads, so the strip's Referral and Commission cells are
   * the card's own figures (Mark, 7 Oct: "a card called commissions ... and
   * that should be connected to the card").
   */
  const commission = useJobCommission(jobId, { money });
  const costQ = commission.costQ;

  /*
   * Days, guys and hours come from the field tickets rather than the costing
   * engine, which totals money and does not carry a headcount. One small read
   * beats widening the RPC for three numbers that are only shown here.
   */
  // Shared with invoice-ledger-pull.ts (the ledger report and job ledger),
  // so the hours it counts are the hours this strip shows.
  const effortQ = useQuery({
    queryKey: ["job-ledger-effort", jobId],
    queryFn: () => loadLedgerEffort(supabase as never, jobId),
  });

  const invoicesQ = useQuery({
    queryKey: ["job-ledger-invoices", jobId],
    enabled: billing,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select("billed_amount, collected_amount")
        .eq("job_id", jobId);
      if (error) throw error;
      const rows = data ?? [];
      if (rows.length === 0) return { billed: null as number | null, paid: null as number | null };
      return {
        billed: rows.reduce((s, i) => s + (i.billed_amount ?? 0), 0),
        paid: rows.reduce((s, i) => s + (i.collected_amount ?? 0), 0),
      };
    },
  });

  /*
   * The office's labor charge rate (Settings › Labor rates) for the Labor
   * Charge cell — Mark, 22 Oct: "this is where the job ledger will get the
   * info from". Money, so only read for someone who may see it.
   */
  const chargeQ = useQuery({
    queryKey: ["job-ledger-labor-charge", jobId],
    enabled: money,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("id, account_id, location_id, region")
        .eq("id", jobId)
        .maybeSingle();
      if (!data?.location_id) return null;
      const { ledgerCharges } = await import("@/lib/invoice-ledger-pull");
      const { fetchLedgerLaborCosts } = await import("@/lib/labour");
      const [charges, costs] = await Promise.all([
        ledgerCharges(supabase as never, data as never).catch(() => null),
        fetchLedgerLaborCosts([data.location_id]).catch(() => null),
      ]);
      // Labor = field hours × the office's crew cost (David, 23 Oct).
      return { ...charges, laborCost: costs?.get(data.location_id) ?? null };
    },
  });

  /*
   * 6 Nov (David): on a regular job the supplies bill as the fee schedule's
   * daily rate for the kind of work × the days on site, not as each supply
   * × its charge. A T&M job keeps the per-supply figure: its supplies are
   * on the T&M daily supply list. Money, so read only for a cost viewer.
   */
  const feeQ = useQuery({
    queryKey: ["job-ledger-supply-fee", jobId],
    enabled: money,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("id, loss_type, loss_type_id, job_type")
        .eq("id", jobId)
        .maybeSingle();
      if (!data) return null;
      const { isTmJob } = await import("@/lib/field-forms-visibility");
      if (isTmJob(data.job_type)) return null;
      const { loadSupplyFeeSchedule, resolveLossTypeKey, supplyFeeKindFor } =
        await import("@/lib/supply-fee-schedule");
      // The managed loss type (loss_type_id) is what the job header shows;
      // the legacy enum is only a fallback for jobs that never had one.
      const lossType = await resolveLossTypeKey(supabase as never, data);
      if (!supplyFeeKindFor(lossType)) return null;
      return { lossType, schedule: await loadSupplyFeeSchedule(supabase as never) };
    },
  });

  const referralOwed = commission.totals.referrer;
  const salesmenOwed = commission.totals.salesman;

  /*
   * Figures typed into the strip (Mark: "can we make each box editable"),
   * laid over the calculated rows. Read for every viewer: the database shows
   * each person only the cells they could already see (effort to anyone on
   * the job, money to cost viewers). `available: false` until migration
   * 20261007224500 is applied, and then nothing is typeable.
   */
  const overridesQ = useQuery({
    queryKey: LEDGER_OVERRIDES_KEY(jobId),
    queryFn: () => fetchLedgerOverrides(jobId),
  });
  const overrides = overridesQ.data?.values;

  const rows = useMemo<LedgerRow[]>(() => {
    const cost = costQ.data;
    const typed = overrides ?? {};
    if (!money) {
      const effort = effortRowsWithOverrides(effortQ.data ?? null, typed);
      return billing
        ? [
            ...effort,
            ...billingRowsWithOverrides(
              invoicesQ.data?.billed ?? null,
              invoicesQ.data?.paid ?? null,
              typed,
            ),
          ]
        : effort;
    }
    if (!cost) return [];
    // Referral and Commission are the Commissions card's figures, never
    // typed here (#341 marks them "elsewhere"); commission is on the
    // calculated revenue, not on a typed Billed.
    return ledgerRowsWithOverrides(
      {
        cost,
        effort: effortQ.data ?? null,
        billed: invoicesQ.data?.billed ?? null,
        paid: invoicesQ.data?.paid ?? null,
        referral: referralOwed,
        commission: salesmenOwed,
        // Who referred the job, for the Referral cell (David, 26 Oct).
        referrerName: commission.referrer?.payee_name ?? commission.job?.referred_by_name ?? null,
        laborCharge: chargeQ.data?.laborCharge ?? null,
        laborCost: chargeQ.data?.laborCost ?? null,
        suppliesCharge:
          (feeQ.data
            ? dailySuppliesCharge(feeQ.data.lossType, effortQ.data?.days, feeQ.data.schedule)
            : null) ??
          chargeQ.data?.suppliesCharge ??
          null,
      },
      typed,
    );
  }, [
    feeQ.data,
    money,
    billing,
    costQ.data,
    effortQ.data,
    invoicesQ.data,
    referralOwed,
    salesmenOwed,
    commission.referrer,
    commission.job,
    overrides,
    chargeQ.data,
  ]);

  return {
    rows,
    commission,
    costQ,
    effortQ,
    overridesAvailable: overridesQ.data?.available === true,
    loading: money ? costQ.isLoading : effortQ.isLoading,
  };
}

/**
 * The job ledger across the top of the Billing tab, as spreadsheet cells.
 *
 * David, 22 Sep: "on this job we're three days, 18 guys, 500 hours, costing
 * us XYZ... I'm thinking something along those lines." It started as one
 * sentence of six figures.
 *
 * Mark, 2026-10-06: "have this sticky as well on the billing page", then
 * "also make the sticky bar have 2 rows with the title and the number
 * underneath like excel cells". So it is a two-row table — the ledger card's
 * column names over their figures, every column the card has, in the jobs
 * spreadsheet's order (`ledgerStripCells`). It stays the same `useJobLedger`
 * the card uses; nothing is added up here. Pinning it is the page's job
 * (jobs.$id.tsx), under the job's own sticky header.
 *
 * Sixteen cells do not fit a phone, or every laptop. The table scrolls
 * sideways INSIDE its own box — the cells keep their label-over-number shape —
 * with the tab strip's edge fade (#282) on whichever side has more, so the
 * page itself never scrolls sideways.
 *
 * Money follows the tab's rule (`job.view_costs`): without it the strip is
 * the three effort figures and the money reads are never made. It keeps the
 * name "Job ledger", as plain text: the name used to jump to the full card in
 * the rail, and that card is gone (Mark, 2026-10-07: "remove the job ledger
 * box at the right side") — this strip IS the ledger now, and each cell's
 * note, which the card showed on hover, is on the cell.
 *
 * Mark, 2026-10-07: "can we make each box editable". For who may write job
 * money, a cell takes a typed figure like a sheet (job-ledger-cell.tsx):
 * Garbage, Truck Fee and Misc Fees have no other source, so the figure is the
 * cell; the calculated cells keep their source and the typed figure overrides
 * it on the ledger only, with a dot and "Back to calculated". Referral and
 * Commission are the Commissions card's. The two totals are never typed —
 * they follow their parts (`ledgerRowsWithOverrides`) and, clicked, list
 * them. The map of every cell is LEDGER_CELL_SOURCES.
 */
export function JobLedgerStrip({
  jobId,
  showMoney,
  showBilling = false,
}: {
  jobId: string;
  showMoney: boolean;
  /** job.view_billing: Billed and Paid without any cost cell (T11). */
  showBilling?: boolean;
}) {
  const app = useAppContext();
  // A daily form synced from the offline queue updates the strip (TM6).
  useRefreshTmDerivedOnSync(jobId);
  const { rows, loading, overridesAvailable, costQ } = useJobLedger(jobId, {
    money: showMoney,
    billing: showBilling,
  });
  const cells = ledgerStripCells(rows, { showMoney, showBilling });
  /*
   * Mark, 2026-10-07: "can we make each box editable". Only for who may write
   * job money (canEditLedger mirrors the database's rule), never while
   * viewing as someone else, and only once the overrides table exists —
   * before that the cells stay as they were and say why on hover.
   */
  const mayEdit = showMoney && canEditLedger(app.roles) && !app.writesDisabled;
  const canType = mayEdit && overridesAvailable;
  const edit = useLedgerEditing(
    jobId,
    rows,
    cells.map((c) => c.key),
  );
  /*
   * Mark, 2026-10-14: "you should be able to click anywhere in the box to
   * edit". A typeable cell is its whole column — the label above as well as
   * the figure under it — not just the figure's text. The column lights up
   * as one under the pointer so it reads as one target.
   */
  const [hovered, setHovered] = useState<string | null>(null);
  const typeable = (key: string, row: LedgerRow | null) =>
    canType && row != null && isLedgerEditable(key);
  /** Pressing the label or the cell's padding keeps an open input's focus. */
  const keepFocus = (key: string) => (e: ReactMouseEvent<HTMLElement>) => {
    if (edit.editing !== key) return;
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
  };
  const openFromCell = (key: string) => (e: ReactMouseEvent<HTMLElement>) => {
    // The cell's own controls do their own thing: the figure button already
    // opens the cell, "Back to calculated" must not, and a click inside the
    // open input is typing.
    if ((e.target as HTMLElement).closest("button, input")) return;
    if (edit.editing === key) return;
    edit.start(key);
  };
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [fade, setFade] = useState({ start: false, end: false });
  const ready = !loading && rows.length > 0;
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = () => {
      const next = stripFade(el);
      setFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [ready]);
  if (!ready) return null;
  const cost = costQ.data
    ? {
        total_cost: costQ.data.total_cost,
        revenue: costQ.data.revenue,
        referral_cost: costQ.data.referral_cost,
        commission_cost: costQ.data.commission_cost,
      }
    : null;

  return (
    <div className="flex min-w-0 items-stretch overflow-hidden rounded-md border bg-muted/30 text-xs">
      <div className="flex shrink-0 items-center border-r px-3 font-semibold">
        <span>Job ledger</span>
      </div>
      <div
        ref={scrollerRef}
        data-fade-start={fade.start || undefined}
        data-fade-end={fade.end || undefined}
        className="edge-fade min-w-0 flex-1 overflow-x-auto no-scrollbar"
      >
        <table className="w-full border-collapse" aria-label="Job ledger summary">
          <thead>
            <tr>
              {cells.map((c) => {
                const open = typeable(c.key, c.row);
                return (
                  <th
                    key={c.key}
                    scope="col"
                    data-ledger-header={c.key}
                    onClick={open ? openFromCell(c.key) : undefined}
                    onMouseDown={open ? keepFocus(c.key) : undefined}
                    onMouseEnter={open ? () => setHovered(c.key) : undefined}
                    onMouseLeave={open ? () => setHovered(null) : undefined}
                    className={cn(
                      "whitespace-nowrap border-b border-l px-2 pt-1.5 pb-0.5 text-left text-[11px] font-medium text-muted-foreground first:border-l-0",
                      open && "cursor-pointer",
                      open && hovered === c.key && "bg-muted",
                    )}
                  >
                    {c.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            <tr>
              {cells.map((c) => {
                const r = c.row;
                const own = c.shown && "money" in c.shown ? c.shown : null;
                const value = own ? own.money : r && r.tracked && r.value != null ? r.value : null;
                const name = c.shown && "text" in c.shown ? c.shown.text : undefined;
                const negative = c.key === "profit" && value != null && value < 0;
                const shown =
                  name !== undefined ? (
                    name ? (
                      <span className="block max-w-[11rem] truncate" data-ledger-referrer>
                        {name}
                      </span>
                    ) : (
                      <span aria-label="No referrer">—</span>
                    )
                  ) : value == null ? (
                    /* A dash, not a zero, as on the card: no figure is not
                       nothing spent. */
                    <span aria-label="Not tracked">—</span>
                  ) : r ? (
                    stripValue({ ...r, value })
                  ) : (
                    "—"
                  );
                const how = LEDGER_CELL_SOURCES[c.key]?.edit;
                const open = typeable(c.key, r);
                return (
                  <td
                    key={c.key}
                    title={ledgerCellTitle(own && r ? { ...r, note: own.note } : r, c.key, {
                      mayEdit,
                      available: overridesAvailable,
                    })}
                    data-manual={r?.manual || undefined}
                    onClick={open ? openFromCell(c.key) : undefined}
                    onMouseDown={open ? keepFocus(c.key) : undefined}
                    onMouseEnter={open ? () => setHovered(c.key) : undefined}
                    onMouseLeave={open ? () => setHovered(null) : undefined}
                    className={cn(
                      "whitespace-nowrap border-l px-2 pt-0.5 pb-1.5 text-sm font-semibold tabular-nums first:border-l-0",
                      c.key === "profit" && "bg-background/60",
                      negative && "bg-destructive/10 text-destructive",
                      value == null && !name && "font-normal text-muted-foreground",
                      open && "cursor-pointer",
                      open && hovered === c.key && "bg-muted",
                    )}
                  >
                    {open && r ? (
                      <LedgerEditableCell
                        row={r}
                        editing={edit.editing === c.key}
                        status={edit.status[c.key]}
                        onStart={() => edit.start(c.key)}
                        onFinish={(typed, move, viaKeyboard) =>
                          edit.finish(c.key, typed, move, viaKeyboard)
                        }
                        onRevert={() => edit.revert(c.key)}
                        buttonRef={edit.buttonRef(c.key)}
                      >
                        {shown}
                      </LedgerEditableCell>
                    ) : how === "total" && showMoney ? (
                      <LedgerTotalCell
                        totalKey={c.key as "total_expenses" | "profit"}
                        rows={rows}
                        cost={cost}
                      >
                        {shown}
                      </LedgerTotalCell>
                    ) : (
                      shown
                    )}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A cell's figure: the card's money format, plain numbers for effort. */
function stripValue(r: LedgerRow): string {
  if (r.kind === "money") return formatCell(r);
  return (r.value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function formatCell(r: LedgerRow): string {
  if (r.value == null) return "—";
  if (r.kind === "count") return String(r.value);
  if (r.kind === "hours") return `${r.value}h`;
  return r.value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
