/**
 * David's jobs spreadsheet, as the job's own money view.
 *
 * David, 17 Sep, pointing at the job money area: "this should be the running
 * costs also — it should have the revenue, the labor hours spent on the job and
 * what it costs us... pretty much the items like I have on the spreadsheet I
 * sent you — that we track all the jobs, that counts the days and the guys and
 * the hours and our expenses, what we're billing and all that, commissions. I
 * want to try to replicate that in the system... the goal is to just have one
 * automated system and everybody shouldn't have to put everything in five
 * times."
 *
 * His sheet's columns, in his order:
 *   Date · Address · Incident · Days · Guys · Hours · Garbage · Supplies ·
 *   Truck Fee · Misc Fees · Equipment · Sub Fees · Labor · Total Expenses ·
 *   Billed · Paid · Referral · Commission · Total Profit
 *
 * NOTHING HERE COMPUTES A COST. Every figure is read from `job_running_cost`,
 * which is the one costing engine, or from the invoices. Commission is the
 * single new arithmetic, and it is a percentage of revenue. Building a second
 * costing system to match a spreadsheet would be the opposite of "one
 * automated system".
 *
 * Where a column has no source yet it is marked `tracked: false` and shows as
 * not-tracked rather than as a zero. A zero is a claim that nothing was spent;
 * "not tracked" is the truth, and it is the difference between the office
 * trusting this against the sheet and quietly going back to the sheet.
 */

import type { RunningCost } from "@/lib/running-cost";
import { laborAmount, roundMoneyLoose } from "@/lib/money";

export type LedgerRow = {
  key: string;
  label: string;
  value: number | null;
  kind: "money" | "count" | "hours";
  /** False when nothing in the system feeds this column yet. */
  tracked: boolean;
  /** Why it is empty, or where the number came from. */
  note?: string;
  /**
   * True when the figure was typed into the ledger (job_ledger_overrides)
   * rather than worked out. Only `ledgerRowsWithOverrides` sets it.
   */
  manual?: boolean;
  /**
   * What the system works out for this cell, whether or not a typed figure
   * replaces it: the "calculated $X" in the manual cell's tooltip, and what
   * "Back to calculated" returns to. Null for an entry with no source.
   */
  calculated?: number | null;
  /**
   * A name shown in the cell instead of the figure — the Referral cell shows
   * WHO referred the job (David, 26 Oct); its money stays in `value`.
   */
  text?: string | null;
};

export type CommissionSource = {
  key: string;
  label: string;
  pct: number;
  /**
   * A named person (Shia Spira, Mark Adelman) or a role default (Salesman,
   * PA). David, 24 Sep: "I just have a dropdown, I select his name and his
   * rate automatically deducts." Older rows carry no kind; see kindOf.
   */
  kind?: "person" | "role";
  /** False = no longer offered for new jobs; jobs that used it keep it. */
  active?: boolean;
};

/** The seeded role keys; everything else seeded is a person. */
const SEEDED_ROLE_KEYS = new Set(["salesman", "broker", "pa", "called_in"]);

export function kindOf(s: CommissionSource): "person" | "role" {
  return s.kind ?? (SEEDED_ROLE_KEYS.has(s.key) ? "role" : "person");
}

export const isActiveSource = (s: CommissionSource) => s.active !== false;

export const DEFAULT_COMMISSION_SOURCES: CommissionSource[] = [
  { key: "salesman", label: "Salesman", pct: 10 },
  { key: "broker", label: "Broker", pct: 10 },
  { key: "pa", label: "PA", pct: 20 },
  { key: "called_in", label: "Called In", pct: 0 },
  { key: "shia_spira", label: "Shia Spira", pct: 25 },
  { key: "star_moore", label: "Star Moore", pct: 30 },
  { key: "klein_gsr", label: "Klein — GSR job", pct: 20 },
  { key: "klein_out_of_town", label: "Klein — out of town", pct: 25 },
  { key: "klein_in_town", label: "Klein — in town", pct: 35 },
];

/** Whatever was stored, field by field, falling back rather than blanking. */
export function parseCommissionSources(raw: unknown): CommissionSource[] {
  const list = (raw as { sources?: unknown })?.sources;
  if (!Array.isArray(list)) return DEFAULT_COMMISSION_SOURCES;
  const out = list
    .map((entry) => {
      const s = (entry ?? {}) as Record<string, unknown>;
      const key = typeof s.key === "string" ? s.key.trim() : "";
      const pct = Number(s.pct);
      if (!key || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
      return {
        key,
        label: typeof s.label === "string" && s.label.trim() ? s.label.trim() : key,
        pct,
        ...(s.kind === "person" || s.kind === "role" ? { kind: s.kind } : {}),
        ...(s.active === false ? { active: false } : {}),
      };
    })
    .filter((s): s is CommissionSource => s !== null);
  return out.length > 0 ? out : DEFAULT_COMMISSION_SOURCES;
}

/*
 * The rate and amount used to be worked out here (commissionRate /
 * commissionAmount). Mark, 7 Oct, made it a card with referrer deals and flat
 * fees; the one calculation is now src/lib/job-commission.ts, and the ledger
 * only reads its figures.
 */

export type LedgerInput = {
  cost: RunningCost;
  /** From the job's own field tickets: days worked, crew, person-hours. */
  effort: { days: number; crew: number; personHours: number } | null;
  billed: number | null;
  paid: number | null;
  /**
   * What the job's REFERRER is owed — the Commissions card's referrer line
   * (`src/lib/job-commission.ts`). Null when no deal says what. Referral
   * costs typed on Cost by work component are already in the running cost
   * (`referral_cost`) and are added to this in the Referral column.
   */
  referral: number | null;
  /**
   * What Gold Star's SALESMEN are owed on the job — the Commissions card's
   * salesman lines, from the rep commission engine. Null when there are none.
   *
   * Mark, 7 Oct: "and reports, it needs to be able to separate salesman and
   * referrers." The sheet already had the two columns side by side
   * (Referral · Commission), so each kind takes one.
   */
  commission: number | null;
  /** Who referred the job (the Commissions card's referrer), for the Referral cell. */
  referrerName?: string | null;
  /**
   * The office's labor CHARGE rate — what an hour is billed to the customer
   * (Settings › Labor rates, labour-bill-rates.ts). Mark, 22 Oct: "the job
   * ledger will get the info from" there. Absent or null: the Labor Charge row
   * says no rate is set rather than inventing one.
   */
  laborCharge?: { rate: number; source: string } | null;
  /**
   * The office's crew COST rate (Settings › Cost rates › Labor — Labor cost).
   * David, 23 Oct: "Labor on job ledger should multiply the field hours by
   * the cost put in to the crew cost." When set, Labor is Hours × this, and
   * Total Expenses and Profit move with it. Absent: the running cost's labour.
   */
  laborCost?: { rate: number; source: string } | null;
  /**
   * What the job's supplies bill at — each supply × its charge in Settings ›
   * Cost rates › Materials & supplies (the price the "From ledger" invoice
   * uses). David, 23 Oct: cost AND charge for materials, read by the ledger.
   */
  suppliesCharge?: { amount: number; unpriced: number; source: string } | null;
};

const money = (label: string, key: string, value: number, note?: string): LedgerRow => ({
  key,
  label,
  value,
  kind: "money",
  tracked: true,
  note,
});

const untracked = (key: string, label: string, note: string): LedgerRow => ({
  key,
  label,
  value: null,
  kind: "money",
  tracked: false,
  note,
});

/**
 * His sheet, column by column, in his order.
 *
 * The three that have no source are named rather than dropped, because a
 * missing column is the thing he would notice first when checking this against
 * the spreadsheet — and a silent omission looks like a bug, while a stated
 * "not tracked yet" is a decision he can argue with.
 */
/**
 * Days, guys and hours — the three rows that are effort, not money. Their own
 * function so the summary strip can show them to someone who may not see
 * costs, from the same definition the full ledger uses.
 */
export function ledgerEffortRows(effort: LedgerInput["effort"]): LedgerRow[] {
  return [
    {
      key: "days",
      label: "Days",
      value: effort?.days ?? null,
      kind: "count",
      tracked: !!effort,
      note: "Days a crew filed a field ticket — on a T&M job, days with a signed sign-in sheet.",
    },
    {
      key: "guys",
      label: "Guys",
      value: effort?.crew ?? null,
      kind: "count",
      tracked: !!effort,
      note: "The largest crew on any one day, not the sum of every day.",
    },
    {
      key: "hours",
      label: "Hours",
      value: effort?.personHours ?? null,
      kind: "hours",
      tracked: !!effort,
      note: "Person-hours on the field tickets (crew size × hours on site) — on a T&M job, the signed sign-in sheets\u2019 hours.",
    },
  ];
}

export function jobLedgerRows(input: LedgerInput): LedgerRow[] {
  const c = input.cost;
  const labour = c.labour_cost + c.field_ticket_labour_cost;
  const equipment = c.equipment_cost + c.field_ticket_equipment_cost;
  const supplies = c.materials_cost + c.stock_used_cost;
  // P5.1: Labor is the running cost's labour — each day's hours at the crew
  // rate in force that day — so it shifts nothing.
  const laborShift = 0;

  return [
    ...ledgerEffortRows(input.effort),
    untracked(
      "garbage",
      "Garbage",
      "No dumpster or disposal cost is recorded against a job yet — it lands in expenses if somebody types it.",
    ),
    money("Supplies", "supplies", supplies, "Requested supplies and stock taken off the shelf."),
    suppliesChargeRow(input.suppliesCharge ?? null),
    untracked("truck_fee", "Truck Fee", "No per-job vehicle charge exists in the system yet."),
    untracked(
      "misc_fees",
      "Misc Fees",
      "The Job Calculator has a miscellaneous fee, but it prices a quote rather than recording a cost.",
    ),
    money(
      "Equipment",
      "equipment",
      equipment,
      "Placements by daily rate, plus machines on tickets.",
    ),
    money("Sub Fees", "sub_fees", c.subcontractor_cost),
    laborRow(labour),
    laborChargeRow(input.effort?.personHours ?? null, input.laborCharge ?? null),
    money(
      "Total Expenses",
      "total_expenses",
      round2(c.total_cost + laborShift),
      commissionInRunningCost(c)
        ? "Everything above that has a source, plus the Referral and Commission owed (the running cost counts them)."
        : "Everything above that has a source.",
    ),
    {
      key: "billed",
      label: "Billed",
      value: input.billed,
      kind: "money",
      tracked: input.billed != null,
      note: "Invoiced on this job.",
    },
    {
      key: "paid",
      label: "Paid",
      value: input.paid,
      kind: "money",
      tracked: input.paid != null,
      note: "Collected against those invoices.",
    },
    referralRow(c.referral_cost, input.referral, input.referrerName ?? null),
    {
      key: "commission",
      label: "Commission",
      value: input.commission,
      kind: "money",
      tracked: input.commission != null,
      note: "Sales reps' commission on this job, from the commission engine — see the Commissions card.",
    },
    {
      key: "profit",
      label: "Total Profit",
      value: round2(jobProfit(input) - laborShift),
      kind: "money",
      tracked: true,
      note: "Revenue less every expense above, less what referrers and salesmen are owed.",
    },
  ];
}

/**
 * Supplies Charge: what the job's supplies bill at, beside what they cost
 * (Supplies). Like Labor Charge, information for the invoice — not an
 * expense, not revenue; Total Expenses and Profit do not move with it.
 */
export function suppliesChargeRow(
  charge: { amount: number; unpriced: number; source: string } | null,
): LedgerRow {
  if (!charge) {
    return {
      key: "supplies_charge",
      label: "Supplies Charge",
      value: null,
      kind: "money",
      tracked: false,
      note: "Supply charges are set in Billing & Costs › Cost › Supplies book.",
    };
  }
  const missing = charge.unpriced
    ? ` ${charge.unpriced} suppl${charge.unpriced === 1 ? "y has" : "ies have"} no charge set and count as $0.`
    : "";
  return {
    key: "supplies_charge",
    label: "Supplies Charge",
    value: round2(charge.amount),
    kind: "money",
    tracked: true,
    note: charge.source.startsWith("Supplies fee schedule")
      ? `${charge.source}. What the supplies bill at; not counted in expenses or profit.`
      : `Each supply × its charge — ${charge.source}. What the supplies bill at; not counted in expenses or profit.${missing}`,
  };
}

/**
 * Labor: what the field hours cost — each day's hours at the crew rate in
 * force on that work day (field tickets, then the time clock on days no
 * ticket covers): the running cost's labour, the one hours × rate rule
 * (Billing & Costs P5.1). It used to be all the hours × TODAY's office rate,
 * which re-priced last month's work whenever the wage changed.
 */
export function laborRow(runningLabour: number): LedgerRow {
  return money(
    "Labor",
    "labor",
    runningLabour,
    "Each day's hours at that day's crew rate — field tickets first; the time clock on days no ticket covers.",
  );
}

/**
 * Labor for hours someone TYPED on the ledger: no work days to price them
 * on, so the office's current crew cost rate.
 */
export function typedHoursLaborRow(
  hours: number | null,
  cost: { rate: number; source: string } | null,
  fallback: number,
): LedgerRow {
  if (!cost || !(cost.rate > 0) || hours == null) return laborRow(fallback);
  return money(
    "Labor",
    "labor",
    laborAmount(hours, cost.rate),
    `Typed hours × $${cost.rate.toFixed(2)}/hr — ${cost.source}.`,
  );
}

/**
 * Labor Charge: the ledger's hours × the office's charge rate — what the
 * labour bills at, beside what it cost (Labor). Information for writing the
 * invoice, NOT an expense and not revenue: Total Expenses and Profit do not
 * move with it (Billed is what was actually invoiced).
 */
export function laborChargeRow(
  hours: number | null,
  charge: { rate: number; source: string } | null,
): LedgerRow {
  if (!charge || !(charge.rate > 0)) {
    return {
      key: "labor_charge",
      label: "Labor Charge",
      value: null,
      kind: "money",
      tracked: false,
      note: "No labor charge rate for this office — set one in Billing & Costs › General Rates.",
    };
  }
  return {
    key: "labor_charge",
    label: "Labor Charge",
    value: hours == null ? null : laborAmount(hours, charge.rate),
    kind: "money",
    tracked: hours != null,
    note: `Hours × $${charge.rate.toFixed(2)}/hr — ${charge.source}. What the labor bills at; not counted in expenses or profit.`,
  };
}

/**
 * The Referral column: what the referrer is owed (the Commissions card) plus
 * any referral cost typed on Cost by work component. A dash only when there
 * is neither — a referrer with no deal and nothing typed is "not set", not $0.
 */
function referralRow(typed: number, owed: number | null, name: string | null): LedgerRow {
  const value = owed == null && !typed ? null : roundMoneyLoose(typed + (owed ?? 0));
  const who = name?.trim() || null;
  const amount =
    value == null
      ? "no referral commission set"
      : `${value.toLocaleString("en-US", { style: "currency", currency: "USD" })} owed — in Commission`;
  return {
    key: "referral",
    label: "Referral",
    value,
    kind: "money",
    tracked: value != null,
    text: who,
    note: who
      ? `Referred by ${who} · ${amount} (the Commissions card).`
      : owed == null
        ? "No referrer on this job yet — set the referrer on the General tab and the deal on the Commissions card."
        : "What the referrer is owed (the Commissions card), plus referral costs typed on the job.",
  };
}

/**
 * Revenue, less costs, less commission.
 *
 * Commission counts, as David asked. An unknown commission is treated as zero
 * HERE and only here — a profit line has to show a number — but the row above
 * says it is not set, so the reader can see the figure is provisional rather
 * than being told the job earned more than it did with no explanation.
 */
export function jobProfit(input: LedgerInput): number {
  // Commission is counted ONCE. Since 20261007224300 the running cost carries
  // it inside total_cost (commission_cost is set), so profit is the running
  // cost's own margin and nothing more comes off. On a database without that
  // migration total_cost has no commission in it, so the card's figures —
  // the referrer's deal and the salesmen's — come off here instead. Typed
  // referral costs were always inside total_cost.
  const owed = commissionInRunningCost(input.cost)
    ? 0
    : (input.referral ?? 0) + (input.commission ?? 0);
  return roundMoneyLoose(input.cost.revenue - input.cost.total_cost - owed);
}

/** True once job_running_cost counts commission in total_cost (20261007224300). */
export function commissionInRunningCost(cost: Pick<RunningCost, "commission_cost">): boolean {
  return cost.commission_cost != null;
}

/**
 * The summary strip atop the job's money view — the ledger's own rows, picked
 * by key, in the order of David's spreadsheet.
 *
 * David, 22 Sep: "on this job we're three days, 18 guys, 500 hours, costing
 * us XYZ... I'm thinking something along those lines." That was six figures
 * in a sentence.
 *
 * Mark, 2026-10-06: "have this sticky as well on the billing page", then
 * "also make the sticky bar have 2 rows with the title and the number
 * underneath like excel cells". He listed the columns from the ledger card:
 * Days, Guys, Hours, Garbage, Supplies, Truck Fee, Misc Fees, Equipment, Sub
 * Fees, Labor, Total Expenses, Billed, Paid, Referral, Commission, Total
 * Profit — which is every row the card has, so the strip now carries them
 * all, under the card's own labels (`LedgerRow.label`), as a header row over
 * a value row.
 *
 * Picked, never recomputed. The strip is the ledger read across; a second
 * arithmetic here is exactly how the strip and the full ledger would come to
 * disagree. `money` marks the cells hidden from a viewer without cost access
 * — the effort figures are not money and stay.
 */
export const LEDGER_STRIP: { key: string; money: boolean; billing?: true }[] = [
  { key: "days", money: false },
  { key: "guys", money: false },
  { key: "hours", money: false },
  { key: "garbage", money: true },
  { key: "supplies", money: true },
  { key: "supplies_charge", money: true },
  { key: "truck_fee", money: true },
  { key: "misc_fees", money: true },
  { key: "equipment", money: true },
  { key: "sub_fees", money: true },
  { key: "labor", money: true },
  { key: "labor_charge", money: true },
  { key: "total_expenses", money: true },
  // Billed and Paid are also shown with job.view_billing alone (T11: a
  // seller sees what was billed and paid, never what it cost).
  { key: "billed", money: true, billing: true },
  { key: "paid", money: true, billing: true },
  { key: "referral", money: true },
  { key: "commission", money: true },
  { key: "profit", money: true },
];

export type LedgerStripCell = {
  key: string;
  label: string;
  row: LedgerRow | null;
  /**
   * What the cell shows when it is not the row's own figure (David, 26 Oct):
   * Referral shows the referrer's NAME, and Commission the whole commission —
   * the referrer's plus the sales reps'. The rows' values, the totals and the
   * report are unchanged.
   */
  shown?: { text: string | null } | { money: number | null; note: string };
};

/** The Commission cell: referrer's commission + sales reps', and how it splits. */
export function commissionCellFigure(rows: readonly LedgerRow[]): {
  money: number | null;
  note: string;
} {
  const by = new Map(rows.map((r) => [r.key, r]));
  const fig = (k: string) => {
    const r = by.get(k);
    return r && r.tracked && r.value != null ? r.value : null;
  };
  const referral = fig("referral");
  const reps = fig("commission");
  const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (referral == null && reps == null) {
    return { money: null, note: "No commission on this job yet — see the Commissions card." };
  }
  const who = by.get("referral")?.text;
  const parts = [
    referral != null ? `Referral${who ? ` (${who})` : ""} ${usd(referral)}` : null,
    reps != null ? `Sales reps ${usd(reps)}` : null,
  ].filter(Boolean);
  return {
    money: roundMoneyLoose((referral ?? 0) + (reps ?? 0)),
    note: `${parts.join(" + ")} — the Commissions card.`,
  };
}

export function ledgerStripCells(
  rows: LedgerRow[],
  opts: { showMoney: boolean; showBilling?: boolean },
): LedgerStripCell[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return LEDGER_STRIP.filter(
    (c) => opts.showMoney || !c.money || (opts.showBilling === true && c.billing === true),
  ).map((c) => {
    const row = byKey.get(c.key) ?? null;
    // The card's own label, so the strip and the card name a column alike.
    const cell: LedgerStripCell = { key: c.key, label: row?.label ?? c.key, row };
    if (c.key === "referral") cell.shown = { text: row?.text ?? null };
    if (c.key === "commission") cell.shown = commissionCellFigure(rows);
    return cell;
  });
}

/* ------------------------------------------------------------------ */
/* Editable cells                                                       */
/* ------------------------------------------------------------------ */

/**
 * Mark, of the pinned strip: "can we make each box editable".
 *
 * Every cell, where its number comes from today, and what typing into it
 * does. This is the map in the PR, kept as data so the strip, the migration's
 * CHECK and the tests all read the one list.
 *
 *   entry     — nothing in the system records it per job, so the typed figure
 *               IS the cell (Garbage, Truck Fee, Misc Fees).
 *   override  — calculated from somewhere else; a typed figure replaces it on
 *               the ledger ONLY. It is stored apart from the source
 *               (job_ledger_overrides) and never writes back: overriding Billed
 *               does not touch an invoice, Equipment does not touch a
 *               placement, Hours does not touch a ticket or a time entry.
 *   elsewhere — Referral and Commission are set on the Commissions card and
 *               read here; a second place to type them would be two answers.
 *   total     — worked out from the cells above. Not typeable: a typed total
 *               would contradict its own parts the moment one of them moved.
 *
 * `feeds` is which total moves when the cell does.
 */
export type LedgerCellEdit = "entry" | "override" | "elsewhere" | "total";
export type LedgerTotalKey = "total_expenses" | "profit";

export type LedgerCellSource = {
  edit: LedgerCellEdit;
  /** Where the number comes from today, in plain words. */
  source: string;
  feeds: LedgerTotalKey[];
};

const BOTH: LedgerTotalKey[] = ["total_expenses", "profit"];

export const LEDGER_CELL_SOURCES: Record<string, LedgerCellSource> = {
  days: {
    edit: "override",
    source: "Field work tickets: the number of different days a ticket was filed.",
    feeds: [],
  },
  guys: {
    edit: "override",
    source: "Field work tickets: the largest crew (GSR + temp) on any one ticket.",
    feeds: [],
  },
  hours: {
    edit: "override",
    source: "Field work tickets: hours on site × crew size, summed.",
    feeds: [],
  },
  garbage: {
    edit: "entry",
    source: "Nothing in the system records it per job; typed here.",
    feeds: BOTH,
  },
  supplies: {
    edit: "override",
    source:
      "Running cost: supply requests × catalog unit cost, plus stock taken off the shelf for the job.",
    feeds: BOTH,
  },
  truck_fee: {
    edit: "entry",
    source: "Nothing in the system records it per job; typed here.",
    feeds: BOTH,
  },
  misc_fees: {
    edit: "entry",
    source: "Nothing in the system records it per job; typed here.",
    feeds: BOTH,
  },
  equipment: {
    edit: "override",
    source:
      "Running cost: drying-log placements × daily rate × days on site, plus machines on field tickets.",
    feeds: BOTH,
  },
  sub_fees: {
    edit: "override",
    source: "Running cost: subcontractor cost typed on the job's cost lines, summed.",
    feeds: BOTH,
  },
  labor: {
    edit: "override",
    source:
      "Field hours × the crew cost rate (Billing & Costs › Cost › Overhead engine, Wage). With no cost rate set: the running cost — crew cost on field tickets, plus the time clock on days no ticket covers.",
    feeds: BOTH,
  },
  total_expenses: {
    edit: "total",
    source:
      "Running cost total: every counted cost on the job, including logged expenses and cost lines that have no cell of their own.",
    feeds: ["profit"],
  },
  billed: {
    edit: "override",
    source: "Invoices: billed amount, summed.",
    // Only once typed: a typed Billed is the revenue the profit is taken from.
    feeds: ["profit"],
  },
  paid: {
    edit: "override",
    source: "Invoices: collected amount, summed.",
    feeds: [],
  },
  supplies_charge: {
    edit: "elsewhere",
    source:
      "The job's supplies × their charge — set in Billing & Costs › Cost › Supplies book. Not an expense.",
    feeds: [],
  },
  labor_charge: {
    edit: "elsewhere",
    source:
      "The ledger's hours × the labor charge rate — set in Billing & Costs › General Rates. Not an expense; it follows the Hours cell.",
    feeds: [],
  },
  referral: {
    edit: "elsewhere",
    source:
      "What the referrer is owed (their deal on the job's revenue, or a flat fee), plus referral costs typed on the job — set on the Commissions card.",
    feeds: BOTH,
  },
  commission: {
    edit: "elsewhere",
    source:
      "What the sales reps are owed on this job, from the commission engine — shown on the Commissions card.",
    feeds: ["profit"],
  },
  profit: {
    edit: "total",
    source: "Revenue, less Total Expenses, less what the referrer and the salesmen are owed.",
    feeds: [],
  },
};

/** The cells a figure can be typed into — the migration's cell_key CHECK. */
export const LEDGER_EDITABLE_KEYS: readonly string[] = Object.entries(LEDGER_CELL_SOURCES)
  .filter(([, s]) => s.edit === "entry" || s.edit === "override")
  .map(([k]) => k);

export const isLedgerEditable = (key: string) => LEDGER_EDITABLE_KEYS.includes(key);

/**
 * Who may type into the ledger: exactly who may write job money today, the
 * job_cost_lines write rule (owner, admin, sales_head). The database decides
 * (job_ledger_cell_writable, 20261007224500); this only hides the editing from
 * people it would refuse.
 */
export const LEDGER_EDIT_ROLES = ["owner", "admin", "sales_head"] as const;

export function canEditLedger(roles: readonly string[] | null | undefined): boolean {
  return (roles ?? []).some((r) => (LEDGER_EDIT_ROLES as readonly string[]).includes(r));
}

/** A typed figure, by cell key. */
export type LedgerOverrides = Record<string, { value: number; updatedAt?: string | null }>;

const round2 = roundMoneyLoose;

/**
 * The typed figures laid over the calculated rows.
 *
 * Totals are NOT re-added from the cells. They start from the shared figures
 * — `total_cost` from the running-cost engine and `jobProfit` — and move by
 * exactly the difference each typed cell makes. So whatever the engine counts
 * (and whatever it starts counting, commission included, when the
 * Commissions card lands) is counted once, and a typed cell can only add its
 * own difference.
 *
 *   Total Expenses = running-cost total + Σ (typed − calculated) over the
 *                    expense cells (an entry's calculated is 0).
 *   Total Profit   = shared profit − that same difference, and, when Billed is
 *                    typed, + (typed Billed − the revenue the engine used).
 */
export function ledgerRowsWithOverrides(
  input: LedgerInput,
  overrides: LedgerOverrides,
): LedgerRow[] {
  const rows = jobLedgerRows(input).map((r) => applyOverride(r, overrides[r.key]));
  let expenseDelta = 0;
  let revenueDelta = 0;
  for (const r of rows) {
    if (!r.manual) continue;
    const delta = (r.value ?? 0) - (r.calculated ?? 0);
    if (LEDGER_CELL_SOURCES[r.key]?.feeds.includes("total_expenses")) expenseDelta += delta;
    if (r.key === "billed") revenueDelta = (r.value ?? 0) - input.cost.revenue;
  }
  // Labor at Hours × crew cost follows a typed Hours cell, unless Labor itself
  // is typed; the difference moves the totals like any typed cell.
  const typedHours = rows.find((r) => r.key === "hours" && r.manual);
  const laborAt = rows.findIndex((r) => r.key === "labor");
  if (typedHours && laborAt >= 0 && !rows[laborAt].manual && input.laborCost?.rate) {
    const repriced = typedHoursLaborRow(
      typedHours.value ?? null,
      input.laborCost,
      rows[laborAt].value ?? 0,
    );
    expenseDelta += (repriced.value ?? 0) - (rows[laborAt].value ?? 0);
    rows[laborAt] = { ...rows[laborAt], value: repriced.value, note: repriced.note };
  }
  // Labor Charge follows the Hours cell as shown — a typed Hours re-prices it.
  const hours = rows.find((r) => r.key === "hours");
  return rows.map((r) => {
    if (r.key === "labor_charge" && hours?.manual) {
      return laborChargeRow(hours.value ?? null, input.laborCharge ?? null);
    }
    if (r.key === "total_expenses") {
      return { ...r, value: round2((r.value ?? 0) + expenseDelta) };
    }
    if (r.key === "profit") {
      return { ...r, value: round2((r.value ?? 0) - expenseDelta + revenueDelta) };
    }
    return r;
  });
}

/** Days, guys and hours alone, for a viewer without cost access. */
/**
 * The rows a billing-only viewer gets beside the effort rows: Billed and
 * Paid, nothing that is a cost (T11).
 */
export function billingRowsWithOverrides(
  billed: number | null,
  paid: number | null,
  overrides: LedgerOverrides,
): LedgerRow[] {
  const rows: LedgerRow[] = [
    {
      key: "billed",
      label: "Billed",
      value: billed,
      kind: "money",
      tracked: billed != null,
      note: "Invoiced on this job.",
    },
    {
      key: "paid",
      label: "Paid",
      value: paid,
      kind: "money",
      tracked: paid != null,
      note: "Collected against those invoices.",
    },
  ];
  return rows.map((r) => applyOverride(r, overrides[r.key]));
}

export function effortRowsWithOverrides(
  effort: LedgerInput["effort"],
  overrides: LedgerOverrides,
): LedgerRow[] {
  return ledgerEffortRows(effort).map((r) => applyOverride(r, overrides[r.key]));
}

function applyOverride(r: LedgerRow, o: LedgerOverrides[string] | undefined): LedgerRow {
  if (!isLedgerEditable(r.key)) return r;
  const calculated = r.tracked ? r.value : null;
  if (!o || !Number.isFinite(o.value)) return { ...r, calculated, manual: false };
  return { ...r, value: o.value, tracked: true, manual: true, calculated };
}

/**
 * What clicking a total says: the cells that feed it, with their figures, so
 * "why is this the number" has an answer on the strip itself. The lines add
 * up to the total (the tests hold that), including an "other recorded costs"
 * line for what the engine counts with no cell of its own — logged expenses,
 * hand-typed cost lines — which would otherwise look like a gap.
 */
export type LedgerTotalLine = {
  label: string;
  value: number | null;
  sign: 1 | -1;
  manual?: boolean;
};

export function ledgerTotalExplanation(
  key: LedgerTotalKey,
  rows: LedgerRow[],
  cost: {
    total_cost: number;
    revenue: number;
    referral_cost?: number;
    commission_cost?: number | null;
  },
): { lines: LedgerTotalLine[]; total: number | null; note: string } {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const figure = (k: string) => {
    const r = byKey.get(k);
    return r && r.tracked && r.value != null ? r.value : null;
  };
  /*
   * The Referral cell is two things (Commissions card): referral costs typed
   * on the job, which the running cost already counts, and what the
   * referrer's deal comes to, which it does not. Total Expenses holds the
   * first; Total Profit takes the second off separately.
   */
  const referralCell = figure("referral");
  // Since 20261007224300 the running cost counts the deal and the salesmen
  // too: then both cells sit inside Total Expenses whole, and Total Profit is
  // just revenue less Total Expenses — commission is counted once, there.
  const inCost = commissionInRunningCost(cost);
  const referralTyped = inCost ? (referralCell ?? 0) : (cost.referral_cost ?? referralCell ?? 0);
  const referralOwed = round2((referralCell ?? 0) - referralTyped);
  const fig = (k: string) => (k === "referral" && referralCell != null ? referralTyped : figure(k));
  if (key === "total_expenses") {
    const parts = Object.entries(LEDGER_CELL_SOURCES)
      .filter(
        ([k, s]) =>
          s.edit !== "total" &&
          (s.feeds.includes("total_expenses") || (inCost && k === "commission")),
      )
      .map(([k]) => k);
    const lines: LedgerTotalLine[] = parts.map((k) => ({
      label: byKey.get(k)?.label ?? k,
      value: fig(k),
      sign: 1,
      manual: !!byKey.get(k)?.manual,
    }));
    // What the engine counted for the cells that have one: the calculated
    // figure, not the typed one. The rest of its total is "other".
    const counted = parts.reduce((s, k) => {
      const r = byKey.get(k);
      if (!r) return s;
      return s + ((r.manual ? r.calculated : fig(k)) ?? 0);
    }, 0);
    const other = round2(cost.total_cost - counted);
    if (other !== 0) {
      lines.push({ label: "Other recorded costs (expenses, cost lines)", value: other, sign: 1 });
    }
    return {
      lines,
      total: fig("total_expenses"),
      note: "Worked out from these cells, so it isn't typed itself. Change a cell and it follows.",
    };
  }
  const billed = byKey.get("billed");
  const revenue = billed?.manual ? (billed.value ?? 0) : cost.revenue;
  return {
    lines: [
      {
        label: billed?.manual ? "Revenue (Billed, typed)" : "Revenue",
        value: round2(revenue),
        sign: 1,
        manual: !!billed?.manual,
      },
      { label: "Total Expenses", value: fig("total_expenses"), sign: -1 },
      ...(referralOwed !== 0
        ? [{ label: "Referral owed (Commissions card)", value: referralOwed, sign: -1 as const }]
        : []),
      ...(inCost ? [] : [{ label: "Commission", value: fig("commission"), sign: -1 as const }]),
    ],
    total: fig("profit"),
    note: "Worked out from these figures, so it isn't typed itself. Change one and it follows.",
  };
}
