// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The Billing tab's ledger strip, rendered. Mark, 2026-10-06: "make the
 * sticky bar have 2 rows with the title and the number underneath like excel
 * cells". The queries are answered from a fixture, keyed the way
 * `useJobLedger` keys them, so what renders is the real component reading the
 * real ledger rows.
 */
let costs: Record<string, unknown> = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined, isLoading: false };
    const answers: Record<string, unknown> = {
      "job-running-cost": costs,
      "job-ledger-effort": { days: 3, crew: 4, personHours: 1250.5 },
      "job-commission": { commission_source: null, commission_rate_pct: null, paidTracked: false },
      "commission-rates": [],
      "job-ledger-invoices": { billed: 12500, paid: 0 },
    };
    return { data: answers[String(queryKey[0])], isLoading: false };
  },
  useQueryClient: () => ({}),
  useMutation: () => ({ mutate: () => {} }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({ useAppContext: () => ({}) }));

import { JobLedgerStrip } from "./job-ledger-panel";

const COST = {
  labour_cost: 9000,
  field_ticket_labour_cost: 1000,
  equipment_cost: 2500,
  field_ticket_equipment_cost: 500,
  materials_cost: 700,
  stock_used_cost: 300,
  subcontractor_cost: 0,
  referral_cost: 0,
  total_cost: 14000,
  revenue: 30000,
};

const render = (showMoney: boolean) =>
  renderToStaticMarkup(createElement(JobLedgerStrip, { jobId: "job-1", showMoney }));

describe("the ledger strip, rendered", () => {
  it("is one header row of eighteen labels over one row of eighteen figures", () => {
    costs = COST;
    const html = render(true);
    // Sixteen of Mark's columns, plus Labor Charge and Supplies Charge.
    expect(html.match(/<th\b/g)).toHaveLength(18);
    expect(html.match(/<td\b/g)).toHaveLength(18);
    expect(html.match(/<tr\b/g)).toHaveLength(2);
    const labels = [...html.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(labels[0]).toBe("Days");
    expect(labels.at(-1)).toBe("Total Profit");
  });

  it("formats money with separators and dashes what is not tracked", () => {
    costs = COST;
    const html = render(true);
    expect(html).toContain("$14,000");
    expect(html).toContain("$12,500");
    expect(html).toContain("1,250.5");
    expect(html).toContain('aria-label="Not tracked"');
  });

  it("shows a loss in the destructive tone, with its minus sign", () => {
    costs = { ...COST, revenue: 10000 };
    const html = render(true);
    // The last cell. It holds a button now (clicking a total explains it),
    // so take the whole cell rather than its bare text.
    const profit = html.slice(html.lastIndexOf("<td"));
    expect(profit).toContain("text-destructive");
    expect(profit).toMatch(/-\$4,000/);
  });

  it("shows only the effort to someone without cost access", () => {
    costs = COST;
    const html = render(false);
    expect(html.match(/<th\b/g)).toHaveLength(3);
    expect(html).not.toContain("$");
    expect(html).toContain("Job ledger");
  });

  it("names itself Job ledger without a link: the card it jumped to is gone", () => {
    costs = COST;
    const html = render(true);
    expect(html).toContain("<span>Job ledger</span>");
    expect(html).not.toContain("<a ");
  });
});
