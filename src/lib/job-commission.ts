/**
 * A job's commission — THE calculation. The Commissions card, the ledger
 * strip's Referral and Commission cells, running cost and the commissions
 * report all call this; none of them works a commission out on its own.
 *
 * Mark, 7 Oct: "we want to replace the ledger to be replaced with a card
 * called commissions, it will pull the referring company from general, (in
 * admin we need to be able put the rates for each referral) ... commission
 * amount, which will auto calculate as the charges get added, or a flat fee,
 * and running cost needs to add that into its calculation as well". Then:
 * "and reports, it needs to be able to separate salesman and referrers."
 *
 * Two kinds of payee, and the kind is a FACT of where the line came from,
 * never guessed from a name:
 *
 *  - `referrer` — the company or person on the job's General tab who sent the
 *    work. Its deal is resolved here (see `resolveReferrerBasis`).
 *  - `salesman` — Gold Star's own rep, paid by the commission engine
 *    (`compute_job_commissions` → `commission_payouts`). That engine is the
 *    source of truth for reps; this file only turns its payouts into lines.
 *
 * A job can owe both, so a job's commission is a LIST of lines.
 *
 * The base a percentage is taken of is the job's revenue as job_running_cost
 * reports it — invoiced, else the approved estimate, else the agreed price,
 * else the newest priced estimate. It is the base the job's commission has
 * used since 20260918190000, so it "auto calculates as the charges get
 * added": a new estimate line or invoice moves the revenue and the commission
 * with it. The SQL twin is `public.job_referrer_commission` (running cost's
 * migration 20261007224300). Both run the same cases — supabase/tests/fixtures/
 * referrer-commission-cases.json — in job-commission.parity.test.ts and
 * running-cost-commission.pglite.mjs, so they cannot drift.
 */

import type { CommissionSource } from "@/lib/job-ledger";
import { roundMoney } from "@/lib/money";

export type PayeeKind = "salesman" | "referrer";
export type RuleKind = "percent" | "flat";

/** One row of referral_commission_rules (migration 20261007224100). */
export type ReferralRule = {
  id: string;
  account_id: string | null;
  contact_id: string | null;
  kind: RuleKind;
  value: number;
  effective_from: string | null;
  effective_to: string | null;
  note?: string | null;
};

/**
 * Where the deal that applies came from, most specific first:
 *   override — typed on this job (rate or flat fee), beats everything;
 *   person   — the referring contact's own rule;
 *   company  — the referring company's rule;
 *   source   — the "Came from" role or name in Settings › Commissions.
 */
export type BasisOrigin = "override" | "person" | "company" | "source";

export type CommissionBasis = {
  origin: BasisOrigin;
  kind: RuleKind;
  value: number;
  /** The rule's id when origin is person or company. */
  ruleId: string | null;
  /** The commission_rates key when origin is source. */
  sourceKey: string | null;
};

export const BASIS_ORIGIN_LABEL: Record<BasisOrigin, string> = {
  override: "set on this job",
  person: "the person's rule",
  company: "the company's rule",
  source: "the source's default rate",
};

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const round2 = roundMoney;

/**
 * A rule's window holds the day. Blank ends are open. Dates are yyyy-mm-dd.
 * With no day to test (a job with no date) nothing can rule a rule out, so it
 * applies; `ruleFor` still prefers the newest start.
 */
export function ruleApplies(rule: ReferralRule, on: string | null): boolean {
  if (!on) return true;
  if (rule.effective_from && on < rule.effective_from) return false;
  if (rule.effective_to && on > rule.effective_to) return false;
  return true;
}

/**
 * The rule in force for one payee on a day. The database refuses two rules
 * for one payee whose windows overlap, so at most one matches; the newest
 * start wins anyway, so a stale overlap from before that guard never decides
 * by row order.
 */
export function ruleFor(
  rules: readonly ReferralRule[],
  payee: { accountId?: string | null; contactId?: string | null },
  on: string | null,
): ReferralRule | null {
  const matches = rules.filter(
    (r) =>
      ((payee.contactId && r.contact_id === payee.contactId) ||
        (payee.accountId && r.account_id === payee.accountId)) &&
      ruleApplies(r, on),
  );
  matches.sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""));
  return matches[0] ?? null;
}

export type ReferrerInput = {
  /** jobs.referred_by_account_id / referred_by_contact_id — the General tab. */
  accountId: string | null;
  contactId: string | null;
  /** jobs.commission_source — the "Came from" key. */
  sourceKey: string | null;
  /** jobs.commission_rate_pct — a percentage typed for this job only. */
  overridePct: number | null;
  /** jobs.commission_flat_amount — a flat fee typed for this job only. */
  overrideFlat: number | null;
  rules: readonly ReferralRule[];
  sources: readonly CommissionSource[];
  /** The job's date for a rule's window (its created date). */
  on: string | null;
};

/**
 * The deal that applies to the job's referrer, or null when nothing says what
 * the referrer is owed — which is NOT the same as owing nothing, and is shown
 * as "not set", never as $0.
 *
 * Precedence: this job's override → the person's rule → the company's rule →
 * the "Came from" source's default rate. The person beats the company because
 * the person is who actually sent the job (JobReferralPanel: "referral credit
 * … attributes to that individual"); a company rule is the fallback for
 * anybody there without a deal of their own.
 */
export function resolveReferrerBasis(input: ReferrerInput): CommissionBasis | null {
  if (finite(input.overrideFlat)) {
    return {
      origin: "override",
      kind: "flat",
      value: input.overrideFlat,
      ruleId: null,
      sourceKey: null,
    };
  }
  if (finite(input.overridePct)) {
    return {
      origin: "override",
      kind: "percent",
      value: input.overridePct,
      ruleId: null,
      sourceKey: null,
    };
  }
  if (input.contactId) {
    const r = ruleFor(input.rules, { contactId: input.contactId }, input.on);
    if (r)
      return {
        origin: "person",
        kind: r.kind,
        value: Number(r.value),
        ruleId: r.id,
        sourceKey: null,
      };
  }
  if (input.accountId) {
    const r = ruleFor(input.rules, { accountId: input.accountId }, input.on);
    if (r)
      return {
        origin: "company",
        kind: r.kind,
        value: Number(r.value),
        ruleId: r.id,
        sourceKey: null,
      };
  }
  if (input.sourceKey) {
    const s = input.sources.find((x) => x.key === input.sourceKey);
    if (s)
      return { origin: "source", kind: "percent", value: s.pct, ruleId: null, sourceKey: s.key };
  }
  return null;
}

/**
 * What a basis comes to on a base. A flat fee is the fee whatever the job
 * billed. A percentage needs a base; with none (revenue not visible to this
 * viewer) it is unknown — null — not zero. A negative base (credits exceeding
 * charges) owes nothing rather than a refund from the referrer.
 */
export function basisAmount(basis: CommissionBasis | null, base: number | null): number | null {
  if (!basis) return null;
  if (basis.kind === "flat") return round2(Math.max(0, basis.value));
  if (base == null || !Number.isFinite(base)) return null;
  // base × rate is rounded as a whole number of cents, the way ROUND(…, 2)
  // does it in job_referrer_commission, so the two agree to the cent.
  return Math.round(Math.max(0, base) * basis.value) / 100;
}

export type CommissionLine = {
  payee_kind: PayeeKind;
  /** contact id, account id, commission_rates key or user id — see payee_type. */
  payee_id: string | null;
  payee_type: "contact" | "account" | "source" | "user";
  payee_name: string;
  basis: CommissionBasis | null;
  /** What a percentage is taken of. Null for a flat fee or an unknown base. */
  base: number | null;
  /** Owed at today's figures. Null = not known (no deal, or base hidden). */
  amount: number | null;
  status: "paid" | "outstanding";
  /** What was actually paid, when it has been — stored, never recomputed. */
  paid_amount: number | null;
  paid_on: string | null;
  /** The deal in words, for a report line: "8% of revenue · the company's rule". */
  basis_note?: string | null;
};

export type JobReferrerFacts = ReferrerInput & {
  /** Names for the payee; the ids above say which one it is. */
  contactName: string | null;
  accountName: string | null;
  /** jobs.referred_by_name — the free-text referrer from older jobs. */
  referredByName: string | null;
  paidOn: string | null;
  paidAmount: number | null;
};

/**
 * The referrer's line on a job, or null when the job has no referrer at all
 * (nobody on the General tab, no "Came from", no override).
 *
 * The payee is whoever the deal belongs to: the person for a person rule, the
 * company for a company rule; for an override or a source rate it is the
 * person if there is one, else the company, else the source's own name.
 */
export function referrerLine(facts: JobReferrerFacts, base: number | null): CommissionLine | null {
  const basis = resolveReferrerBasis(facts);
  const hasReferrer = !!(facts.contactId || facts.accountId || facts.sourceKey || basis);
  if (!hasReferrer) return null;

  const source = facts.sources.find((s) => s.key === facts.sourceKey) ?? null;
  let payee: Pick<CommissionLine, "payee_id" | "payee_type" | "payee_name">;
  if (basis?.origin === "company" || (!facts.contactId && facts.accountId)) {
    payee = {
      payee_id: facts.accountId,
      payee_type: "account",
      // Not `referredByName` when a person is set: that copy then holds the
      // PERSON's name, and the company row would be labelled with it.
      payee_name:
        facts.accountName ?? (facts.contactId ? null : facts.referredByName) ?? "Referring company",
    };
  } else if (facts.contactId) {
    payee = {
      payee_id: facts.contactId,
      payee_type: "contact",
      payee_name: facts.contactName ?? facts.referredByName ?? "Referring person",
    };
  } else {
    payee = {
      payee_id: source?.key ?? facts.sourceKey,
      payee_type: "source",
      payee_name: source?.label ?? facts.referredByName ?? facts.sourceKey ?? "Referrer",
    };
  }

  const amount = basisAmount(basis, base);
  return {
    payee_kind: "referrer",
    ...payee,
    basis,
    base: basis?.kind === "percent" ? base : null,
    amount,
    status: facts.paidOn ? "paid" : "outstanding",
    paid_amount: facts.paidOn ? (facts.paidAmount ?? amount) : null,
    paid_on: facts.paidOn,
    basis_note: basis ? `${describeBasis(basis)} · ${BASIS_ORIGIN_LABEL[basis.origin]}` : null,
  };
}

const PAYOUT_BASIS_WORD: Record<string, string> = {
  collected: "collected",
  billed: "billed",
  gross_profit: "gross profit",
};

/** One row of commission_payouts, as much of it as a line needs. */
export type SalesmanPayout = {
  user_id: string;
  amount: number;
  status: string;
  basis: string | null;
  basis_amount: number | null;
  rate_percent: number | null;
  paid_at?: string | null;
  issued_on?: string | null;
};

/** Payout states that are not money owed — a cancelled payout is no commission. */
const DEAD_PAYOUT = new Set(["void", "voided", "cancelled", "canceled", "rejected"]);

/**
 * The salesman lines on a job, one per rep, from what the commission engine
 * produced. The engine decides the amount (its plan, tier, split and basis);
 * nothing here second-guesses it. Paid is the payout's own status.
 */
export function salesmanLines(
  payouts: readonly SalesmanPayout[],
  names: Readonly<Record<string, string | null | undefined>>,
): CommissionLine[] {
  return payouts
    .filter((p) => !DEAD_PAYOUT.has(p.status))
    .map((p) => {
      const amount = round2(Number(p.amount) || 0);
      const paid = p.status === "paid";
      return {
        payee_kind: "salesman" as const,
        payee_id: p.user_id,
        payee_type: "user" as const,
        payee_name: names[p.user_id] || "Sales rep",
        basis: null,
        base: p.basis_amount == null ? null : Number(p.basis_amount),
        amount,
        status: paid ? ("paid" as const) : ("outstanding" as const),
        paid_amount: paid ? amount : null,
        paid_on: paid ? (p.paid_at?.slice(0, 10) ?? p.issued_on ?? null) : null,
        basis_note:
          p.rate_percent != null
            ? `${Number(p.rate_percent)}% of ${PAYOUT_BASIS_WORD[p.basis ?? ""] ?? p.basis ?? "the job"}`
            : null,
      };
    });
}

/**
 * Totals by kind — what the strip's Referral (referrers) and Commission
 * (salesmen) cells show. Null when there is no line of that kind or none of
 * its amounts is known, so the strip prints a dash rather than a false $0.
 */
export function commissionTotals(lines: readonly CommissionLine[]): {
  referrer: number | null;
  salesman: number | null;
  total: number | null;
} {
  const sum = (kind: PayeeKind) => {
    const known = lines.filter((l) => l.payee_kind === kind && l.amount != null);
    return known.length ? round2(known.reduce((s, l) => s + (l.amount ?? 0), 0)) : null;
  };
  const referrer = sum("referrer");
  const salesman = sum("salesman");
  const total =
    referrer == null && salesman == null ? null : round2((referrer ?? 0) + (salesman ?? 0));
  return { referrer, salesman, total };
}

/** A basis in words: "12.5% of revenue" or "$250 flat". */
export function describeBasis(basis: Pick<CommissionBasis, "kind" | "value"> | null): string {
  if (!basis) return "No rate set";
  if (basis.kind === "flat") {
    return `${basis.value.toLocaleString("en-US", { style: "currency", currency: "USD" })} flat`;
  }
  return `${basis.value}% of revenue`;
}
