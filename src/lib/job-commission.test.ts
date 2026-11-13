import { describe, expect, it } from "vitest";

import {
  basisAmount,
  commissionTotals,
  describeBasis,
  referrerLine,
  resolveReferrerBasis,
  ruleFor,
  salesmanLines,
  type JobReferrerFacts,
  type ReferralRule,
} from "@/lib/job-commission";
import { DEFAULT_COMMISSION_SOURCES } from "@/lib/job-ledger";

/**
 * Mark, 7 Oct: "it will pull the referring company from general, (in admin we
 * need to be able put the rates for each referral) ... commission amount,
 * which will auto calculate as the charges get added, or a flat fee". Then:
 * "and reports, it needs to be able to separate salesman and referrers."
 *
 * The one calculation every surface calls. These tests pin the precedence,
 * the two kinds of deal, and that the kind of payee is where the line came
 * from — never read off a name.
 */

const ACME = "acme-account";
const JANE = "jane-contact";
const rule = (over: Partial<ReferralRule>): ReferralRule => ({
  id: over.id ?? "r1",
  account_id: null,
  contact_id: null,
  kind: "percent",
  value: 10,
  effective_from: null,
  effective_to: null,
  ...over,
});

const facts = (over: Partial<JobReferrerFacts> = {}): JobReferrerFacts => ({
  accountId: ACME,
  contactId: JANE,
  sourceKey: null,
  overridePct: null,
  overrideFlat: null,
  rules: [],
  sources: DEFAULT_COMMISSION_SOURCES,
  on: "2026-10-01",
  contactName: "Jane Broker",
  accountName: "Acme Brokers",
  referredByName: null,
  paidOn: null,
  paidAmount: null,
  ...over,
});

describe("which deal applies", () => {
  const company = rule({ id: "co", account_id: ACME, kind: "percent", value: 8 });
  const person = rule({ id: "pe", contact_id: JANE, kind: "flat", value: 250 });

  it("the job's own override beats every rule", () => {
    const f = facts({ rules: [company, person], sourceKey: "pa", overridePct: 12 });
    expect(resolveReferrerBasis(f)).toMatchObject({
      origin: "override",
      kind: "percent",
      value: 12,
    });
    const flat = facts({ rules: [company, person], overrideFlat: 400, overridePct: 12 });
    // A flat override and a percent override at once: the flat fee is the
    // more deliberate of the two (somebody typed a dollar figure).
    expect(resolveReferrerBasis(flat)).toMatchObject({
      origin: "override",
      kind: "flat",
      value: 400,
    });
  });

  it("then the person's rule, then the company's, then the source rate", () => {
    expect(
      resolveReferrerBasis(facts({ rules: [company, person], sourceKey: "pa" })),
    ).toMatchObject({
      origin: "person",
      kind: "flat",
      value: 250,
      ruleId: "pe",
    });
    expect(resolveReferrerBasis(facts({ rules: [company], sourceKey: "pa" }))).toMatchObject({
      origin: "company",
      value: 8,
      ruleId: "co",
    });
    expect(resolveReferrerBasis(facts({ rules: [], sourceKey: "pa" }))).toMatchObject({
      origin: "source",
      kind: "percent",
      value: 20,
      sourceKey: "pa",
    });
  });

  it("nothing at all is null — not a zero rate", () => {
    expect(resolveReferrerBasis(facts())).toBeNull();
    expect(resolveReferrerBasis(facts({ sourceKey: "no_such_key" }))).toBeNull();
  });

  it("a rule only applies inside its window; the newest start wins", () => {
    const old = rule({ id: "old", account_id: ACME, value: 5, effective_to: "2026-06-30" });
    const now = rule({ id: "new", account_id: ACME, value: 7, effective_from: "2026-07-01" });
    expect(ruleFor([old, now], { accountId: ACME }, "2026-03-01")?.id).toBe("old");
    expect(ruleFor([old, now], { accountId: ACME }, "2026-10-01")?.id).toBe("new");
    expect(ruleFor([now], { accountId: ACME }, "2026-03-01")).toBeNull();
  });

  it("another company's rule never applies", () => {
    const other = rule({ account_id: "someone-else", value: 50 });
    expect(resolveReferrerBasis(facts({ rules: [other] }))).toBeNull();
  });
});

describe("what it comes to", () => {
  it("a percentage recomputes as the charges move", () => {
    const basis = resolveReferrerBasis(facts({ rules: [rule({ account_id: ACME, value: 10 })] }));
    expect(basisAmount(basis, 0)).toBe(0);
    expect(basisAmount(basis, 12_000)).toBe(1200);
    // An invoice line added: the base moves and the commission with it.
    expect(basisAmount(basis, 12_345.67)).toBe(1234.57);
  });

  it("a flat fee is the fee whatever the job billed, even before any charge", () => {
    const flat = {
      origin: "person" as const,
      kind: "flat" as const,
      value: 250,
      ruleId: "x",
      sourceKey: null,
    };
    expect(basisAmount(flat, null)).toBe(250);
    expect(basisAmount(flat, 0)).toBe(250);
    expect(basisAmount(flat, 99_999)).toBe(250);
  });

  it("a percentage with no visible base is unknown, and a negative base owes nothing", () => {
    const pct = {
      origin: "source" as const,
      kind: "percent" as const,
      value: 10,
      ruleId: null,
      sourceKey: "pa",
    };
    expect(basisAmount(pct, null)).toBeNull();
    expect(basisAmount(pct, -500)).toBe(0);
    expect(basisAmount(null, 10_000)).toBeNull();
  });

  it("describes a deal in words", () => {
    expect(describeBasis({ kind: "percent", value: 12.5 })).toBe("12.5% of revenue");
    expect(describeBasis({ kind: "flat", value: 250 })).toBe("$250.00 flat");
    expect(describeBasis(null)).toBe("No rate set");
  });
});

describe("the referrer's line", () => {
  it("names the payee the deal belongs to", () => {
    const company = facts({ rules: [rule({ account_id: ACME, value: 8 })] });
    expect(referrerLine(company, 10_000)).toMatchObject({
      payee_kind: "referrer",
      payee_type: "account",
      payee_id: ACME,
      payee_name: "Acme Brokers",
      amount: 800,
      base: 10_000,
    });
    const person = facts({ rules: [rule({ contact_id: JANE, kind: "flat", value: 300 })] });
    expect(referrerLine(person, 10_000)).toMatchObject({
      payee_type: "contact",
      payee_id: JANE,
      payee_name: "Jane Broker",
      amount: 300,
      base: null,
    });
  });

  it("a source-only job pays the source's name", () => {
    const line = referrerLine(
      facts({ accountId: null, contactId: null, sourceKey: "shia_spira" }),
      1000,
    );
    expect(line).toMatchObject({
      payee_type: "source",
      payee_id: "shia_spira",
      payee_name: "Shia Spira",
      amount: 250,
    });
  });

  it("a referrer with no deal is a line with no amount, not a $0 line", () => {
    const line = referrerLine(facts(), 10_000);
    expect(line?.basis).toBeNull();
    expect(line?.amount).toBeNull();
  });

  it("no referrer at all is no line", () => {
    expect(referrerLine(facts({ accountId: null, contactId: null }), 10_000)).toBeNull();
  });

  it("paid keeps what was paid, not today's figure", () => {
    const line = referrerLine(
      facts({ overridePct: 10, paidOn: "2026-09-30", paidAmount: 900 }),
      12_000,
    );
    expect(line).toMatchObject({
      status: "paid",
      amount: 1200,
      paid_amount: 900,
      paid_on: "2026-09-30",
    });
  });
});

describe("salesmen and referrers, apart", () => {
  const payouts = [
    {
      user_id: "rep-1",
      amount: 600,
      status: "pending",
      basis: "collected",
      basis_amount: 6000,
      rate_percent: 10,
    },
    {
      user_id: "rep-2",
      amount: 150,
      status: "paid",
      basis: "collected",
      basis_amount: 6000,
      rate_percent: 5,
      paid_at: "2026-09-15T12:00:00Z",
    },
    {
      user_id: "rep-3",
      amount: 999,
      status: "void",
      basis: null,
      basis_amount: null,
      rate_percent: null,
    },
  ];

  it("turns the engine's payouts into salesman lines, dropping dead ones", () => {
    const lines = salesmanLines(payouts, { "rep-1": "Avi Rep", "rep-2": "Bea Rep" });
    expect(lines.map((l) => [l.payee_kind, l.payee_name, l.amount, l.status])).toEqual([
      ["salesman", "Avi Rep", 600, "outstanding"],
      ["salesman", "Bea Rep", 150, "paid"],
    ]);
    expect(lines[1]!.paid_on).toBe("2026-09-15");
  });

  it("a job owing both is two kinds of line, totaled apart", () => {
    const ref = referrerLine(facts({ rules: [rule({ account_id: ACME, value: 10 })] }), 6000)!;
    const all = [ref, ...salesmanLines(payouts, {})];
    expect(all.map((l) => l.payee_kind)).toEqual(["referrer", "salesman", "salesman"]);
    expect(commissionTotals(all)).toEqual({ referrer: 600, salesman: 750, total: 1350 });
  });

  it("a kind with nothing known is null, so the strip shows a dash", () => {
    expect(commissionTotals([])).toEqual({ referrer: null, salesman: null, total: null });
    const unknown = referrerLine(facts(), 6000)!;
    expect(commissionTotals([unknown])).toEqual({ referrer: null, salesman: null, total: null });
  });

  it("the payee kind is where the line came from, never the source's name", () => {
    // "Salesman" is a role in Settings › Commissions. Picked as "Came from",
    // it is still the REFERRER line: the rep's own commission is the engine's.
    const line = referrerLine(
      facts({ accountId: null, contactId: null, sourceKey: "salesman" }),
      1000,
    );
    expect(line?.payee_kind).toBe("referrer");
  });
});
