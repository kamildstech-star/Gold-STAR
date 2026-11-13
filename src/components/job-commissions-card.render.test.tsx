// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The Commissions card and the ledger strip, rendered from ONE fixture.
 *
 * Mark, 7 Oct: "we want to replace the ledger to be replaced with a card
 * called commissions, it will pull the referring company from general ...
 * commission amount, which will auto calculate as the charges get added, or a
 * flat fee". And: "it needs to be able to separate salesman and referrers."
 *
 * The queries are answered by key, the way `useJobCommission` asks them, so
 * what renders is the real card and the real strip reading the real
 * calculation — and the strip's Referral and Commission cells must be the
 * card's own figures.
 */
const DEFAULT_SOURCES = [
  { key: "pa", label: "PA", pct: 20 },
  { key: "salesman", label: "Salesman", pct: 10 },
];

let answers: Record<string, unknown> = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined, isLoading: false };
    return { data: answers[String(queryKey[0])], isLoading: false };
  },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ writesDisabled: false, userId: "u1", roles: ["admin"] }),
}));

import { JobCommissionsCard } from "./job-commissions-card";
import { JobLedgerStrip } from "./job-ledger-panel";

const COST = {
  labour_cost: 1000,
  field_ticket_labour_cost: 0,
  equipment_cost: 500,
  field_ticket_equipment_cost: 0,
  materials_cost: 200,
  stock_used_cost: 0,
  subcontractor_cost: 0,
  referral_cost: 0,
  total_cost: 1700,
  revenue: 10000,
  revenue_basis: "invoice",
};

const JOB = {
  commission_source: "pa",
  commission_rate_pct: null,
  commission_flat_amount: null,
  commission_paid_on: null,
  commission_paid_ref: null,
  commission_paid_amount: null,
  referred_by_account_id: "acme",
  referred_by_contact_id: "jane",
  referred_by_name: "Jane Broker",
  created_at: "2026-10-01T15:00:00Z",
  flatTracked: true,
  paidTracked: true,
};

const fixture = (over: { job?: object; rules?: object[]; payouts?: object[] } = {}) => {
  answers = {
    "job-running-cost": COST,
    "job-commission": { ...JOB, ...over.job },
    "commission-rates": DEFAULT_SOURCES,
    "job-referrer": {
      accountName: "Acme Brokers",
      contactName: "Jane Broker",
      rules: over.rules ?? [
        {
          id: "r1",
          account_id: "acme",
          contact_id: null,
          kind: "percent",
          value: 8,
          effective_from: null,
          effective_to: null,
        },
      ],
      rulesAvailable: true,
    },
    "job-salesman-payouts": {
      payouts: over.payouts ?? [
        {
          user_id: "rep-1",
          amount: 600,
          status: "pending",
          basis: "collected",
          basis_amount: 6000,
          rate_percent: 10,
        },
      ],
      names: { "rep-1": "Avi Rep" },
    },
    "job-ledger-effort": { days: 1, crew: 2, personHours: 16 },
    "job-ledger-invoices": { billed: 10000, paid: 0 },
  };
};

const card = () => renderToStaticMarkup(createElement(JobCommissionsCard, { jobId: "job-1" }));
const strip = () =>
  renderToStaticMarkup(createElement(JobLedgerStrip, { jobId: "job-1", showMoney: true }));
const cell = (html: string, label: string) => {
  const labels = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  return cells[labels.indexOf(label)]!;
};

describe("the Commissions card", () => {
  it("pulls the referrer from the General tab and applies their company's deal", () => {
    fixture();
    const html = card();
    expect(html).toContain("Commissions");
    // The company rule beats the PA source rate; the company is the payee.
    const amount = html.match(/<div[^>]*data-referrer-amount[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)![0];
    // David, 13 Oct: the commission reads as dollars, not a percentage.
    expect(amount).not.toContain("8% of revenue");
    expect(amount).toContain("the company&#x27;s rule");
    expect(amount).toMatch(/data-commission-dollars[^>]*>\$800\.00</);
    expect(amount).toContain("On $10,000 revenue (invoice)");
    expect(html).toContain("Acme Brokers");
  });

  it("separates the salesmen from the referrer and totals both", () => {
    fixture();
    const html = card();
    const ref = html.match(/data-commission-section="referrer"/g);
    const rep = html.match(/data-commission-section="salesman"/g);
    expect(ref).toHaveLength(1);
    expect(rep).toHaveLength(1);
    const line = html.match(/<li[^>]*data-salesman-line[^>]*>[\s\S]*?<\/li>/)![0];
    expect(line).toContain("Avi Rep");
    expect(line).toContain("$600.00");
    expect(line).toContain("Outstanding");
    expect(html.match(/data-commission-total[^>]*>([^<]*)</)![1]).toBe("$1,400.00");
  });

  it("a flat fee typed on the job beats every rule, whatever the revenue", () => {
    fixture({ job: { commission_flat_amount: 350 } });
    const html = card();
    const amount = html.match(/<div[^>]*data-referrer-amount[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)![0];
    expect(amount).toMatch(/data-commission-dollars[^>]*>\$350\.00</);
    expect(amount).toContain("set on this job");
    expect(amount).not.toContain("revenue (");
  });

  it("keeps the stop-gap's three abilities: came from, an amount for this job, mark paid", () => {
    fixture();
    const html = card();
    expect(html).toContain('aria-label="Commission came from"');
    // A dollar amount by default (David, 13 Oct), not a rate.
    expect(html).toContain('aria-label="Commission flat fee override"');
    expect(html).toContain('data-commission-status="outstanding"');
    expect(html).toContain("Mark paid…");
  });

  it("says when there is no referrer, and shows no amount", () => {
    fixture({
      job: { referred_by_account_id: null, referred_by_contact_id: null, commission_source: null },
      payouts: [],
    });
    const html = card();
    expect(html).toContain("data-no-referrer");
    expect(html).toContain("Pick the referring company or person on the General tab.");
    expect(html).not.toContain("data-referrer-amount");
    expect(html).toContain("No sales rep commission on this job.");
  });

  it("before the flat-fee migration, offers only the percentage", () => {
    fixture({ job: { flatTracked: false } });
    const html = card();
    expect(html).not.toContain('aria-label="Override as"');
    expect(html).toContain('aria-label="Commission rate override"');
  });

  it("offers dollars only, unless the job already carries a percentage", () => {
    fixture();
    expect(card()).not.toContain('aria-label="Override as"');
    fixture({ job: { commission_rate_pct: 12.5 } });
    expect(card()).toContain('aria-label="Override as"');
  });

  it("controls are 44px on a phone", () => {
    fixture();
    const html = card();
    const trigger = html.match(/<button[^>]*aria-label="Commission came from"[^>]*>/)![0];
    expect(trigger).toContain("h-11");
  });
});

describe("the ledger strip shows the card's figures", () => {
  // David, 26 Oct: Referral shows WHO referred the job; Commission the
  // whole commission — the referrer's $800 plus the salesmen's $600.
  it("Referral names the referrer, Commission is the referrer's plus the salesmen's", () => {
    fixture();
    const html = strip();
    expect(cell(html, "Referral")).toContain("Acme Brokers"); // the referring company, as on the card
    expect(cell(html, "Commission")).toContain("$1,400");
    // 10,000 − 1,700 − 800 − 600
    expect(cell(html, "Total Profit")).toContain("$6,900");
  });

  it("moves with the card when the deal changes", () => {
    fixture({ job: { commission_flat_amount: 350 } });
    expect(cell(strip(), "Commission")).toContain("$950"); // 350 + 600
    fixture({ rules: [] });
    // No company rule: the PA source rate, 20% of 10,000 — plus the salesmen's 600.
    expect(cell(strip(), "Commission")).toContain("$2,600");
  });
});
