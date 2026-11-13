import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

/**
 * Gold Star's money model is not the industry's.
 *
 * The customer is never quoted and never billed. The carrier is billed, the
 * carrier approves some fraction of it, and whatever is never collected is
 * absorbed margin — the "shortfall". Nobody currently measures it, which is
 * exactly why every screen here carries it as a first-class number.
 *
 *   estimated -> billed -> approved (by carrier) -> collected
 *
 *   carrier shortfall  = billed   - approved     (what the carrier refused)
 *   uncollected        = billed   - collected    (what never arrived)
 *   absorbed           = billed   - collected    (the money Gold Star ate)
 */

export type QuoteStatus = Database["public"]["Enums"]["quote_status"];
export type QuoteCategory = Database["public"]["Enums"]["quote_category"];
export type InvoiceStatus = Database["public"]["Enums"]["invoice_status"];

export const QUOTE_STATUSES: QuoteStatus[] = [
  "draft",
  "internal_review",
  "submitted",
  "approved",
  "rejected",
  "superseded",
];

export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  draft: "Draft",
  internal_review: "Internal review",
  submitted: "Submitted to carrier",
  approved: "Approved",
  rejected: "Rejected",
  superseded: "Superseded",
};

export const QUOTE_STATUS_TONE: Record<QuoteStatus, string> = {
  draft: TONE.neutral,
  internal_review: TONE.info,
  submitted: TONE.brand,
  approved: TONE.success,
  rejected: TONE.danger,
  superseded: TONE.neutral,
};

export const QUOTE_CATEGORIES: string[] = [
  "mitigation",
  "labor",
  "equipment",
  "materials",
  "disposal",
  "reconstruction",
  "other",
];

export const QUOTE_CATEGORY_LABEL: Record<string, string> = {
  mitigation: "Mitigation",
  labor: "Labor",
  equipment: "Equipment",
  materials: "Materials",
  disposal: "Disposal",
  reconstruction: "Reconstruction",
  other: "Other",
};

export const INVOICE_STATUSES: InvoiceStatus[] = [
  "draft",
  "sent",
  "partial",
  "paid",
  "disputed",
  "written_off",
];

export const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  partial: "Part paid",
  paid: "Paid",
  disputed: "Disputed",
  written_off: "Written off",
};

export const INVOICE_STATUS_TONE: Record<InvoiceStatus, string> = {
  draft: TONE.neutral,
  sent: TONE.info,
  partial: TONE.warning,
  paid: TONE.success,
  disputed: TONE.danger,
  written_off: TONE.danger,
};

/** Statuses that still represent money owed to Gold Star. */
export const OPEN_INVOICE_STATUSES: InvoiceStatus[] = ["sent", "partial", "disputed"];

export function fmtUsd(n: number | null | undefined, opts?: { cents?: boolean }): string {
  if (n == null) return "—";
  return Number(n).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: opts?.cents ? 2 : 0,
  });
}

/** Percentage of billed that the carrier approved. Null when nothing billed. */
export function approvalRate(
  billed: number | null | undefined,
  approved: number | null | undefined,
): number | null {
  if (!billed || billed <= 0 || approved == null) return null;
  return approved / billed;
}

export function fmtPct(n: number | null): string {
  if (n == null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export type AgingBucket = "current" | "d30" | "d60" | "d90" | "d90plus";

export const AGING_LABEL: Record<AgingBucket, string> = {
  current: "Current",
  d30: "1–30 days",
  d60: "31–60 days",
  d90: "61–90 days",
  d90plus: "90+ days",
};

/**
 * Aging is measured from the due date; an invoice with no due date ages from
 * its issue date. 90+ is the bucket that means someone has to pick up a phone.
 */
export function agingBucket(
  dueDate: string | null,
  issueDate: string | null,
  now = new Date(),
): AgingBucket {
  const basis = dueDate ?? issueDate;
  if (!basis) return "current";
  const days = Math.floor((now.getTime() - new Date(basis + "T00:00:00").getTime()) / 86400_000);
  if (days <= 0) return "current";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "d90plus";
}

export function daysOutstanding(
  dueDate: string | null,
  issueDate: string | null,
  now = new Date(),
): number {
  const basis = dueDate ?? issueDate;
  if (!basis) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - new Date(basis + "T00:00:00").getTime()) / 86400_000),
  );
}

export type MoneyChain = {
  estimated: number;
  billed: number;
  approved: number;
  collected: number;
  /** billed − approved: what the carrier refused to pay. */
  carrierShortfall: number;
  /** billed − collected: absorbed margin. */
  absorbed: number;
};

export function emptyChain(): MoneyChain {
  return {
    estimated: 0,
    billed: 0,
    approved: 0,
    collected: 0,
    carrierShortfall: 0,
    absorbed: 0,
  };
}

export function addToChain(
  chain: MoneyChain,
  row: {
    estimated_amount?: number | null;
    billed_amount?: number | null;
    approved_amount?: number | null;
    collected_amount?: number | null;
  },
): MoneyChain {
  const billed = Number(row.billed_amount ?? 0);
  // An un-adjudicated invoice is not a shortfall — treat approved as billed
  // until the carrier actually rules on it.
  const approved = row.approved_amount == null ? billed : Number(row.approved_amount);
  const collected = Number(row.collected_amount ?? 0);
  return {
    estimated: chain.estimated + Number(row.estimated_amount ?? 0),
    billed: chain.billed + billed,
    approved: chain.approved + approved,
    collected: chain.collected + collected,
    carrierShortfall: chain.carrierShortfall + (billed - approved),
    absorbed: chain.absorbed + (billed - collected),
  };
}
