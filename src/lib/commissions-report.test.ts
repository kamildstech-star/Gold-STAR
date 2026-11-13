// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { reportExportColumns } from "@/components/report-view";
import {
  commissionColumns,
  commissionKpiTotals,
  commissionsReport,
  filterByKind,
  lineRows,
  rollUpByPayee,
  type ReportLine,
} from "@/lib/commissions-report";
import { referrerLine, salesmanLines } from "@/lib/job-commission";
import { DEFAULT_COMMISSION_SOURCES } from "@/lib/job-ledger";
import { formatReportOptions, parseReportOptions } from "@/lib/report-options";

/**
 * Mark, 7 Oct: "and reports, it needs to be able to separate salesman and
 * referrers." The lines come from THE calculation (referrerLine /
 * salesmanLines); this holds the split, the per-payee subtotals, paid vs
 * outstanding, and the Excel columns.
 */

const ref = (
  job: string,
  over: Partial<Parameters<typeof referrerLine>[0]> = {},
  revenue: number | null = 10000,
): ReportLine => ({
  ...referrerLine(
    {
      accountId: "acme",
      contactId: null,
      sourceKey: null,
      overridePct: null,
      overrideFlat: null,
      rules: [
        {
          id: "r",
          account_id: "acme",
          contact_id: null,
          kind: "percent",
          value: 8,
          effective_from: null,
          effective_to: null,
        },
      ],
      sources: DEFAULT_COMMISSION_SOURCES,
      on: "2026-10-01",
      contactName: null,
      accountName: "Acme Brokers",
      referredByName: null,
      paidOn: null,
      paidAmount: null,
      ...over,
    },
    revenue,
  )!,
  job_id: job,
  job_number: job.toUpperCase(),
});

const rep = (job: string, user: string, amount: number, status = "pending"): ReportLine => ({
  ...salesmanLines(
    [
      {
        user_id: user,
        amount,
        status,
        basis: "collected",
        basis_amount: amount * 10,
        rate_percent: 10,
      },
    ],
    { avi: "Avi Rep", bea: "Bea Rep" },
  )[0]!,
  job_id: job,
  job_number: job.toUpperCase(),
});

// Job j1 owes BOTH a salesman and a referrer — two lines.
const LINES: ReportLine[] = [
  ref("j1"),
  rep("j1", "avi", 600),
  ref("j2", { paidOn: "2026-10-05", paidAmount: 750 }),
  rep("j2", "avi", 300, "paid"),
  rep("j3", "bea", 200),
  ref("j4", {}, null), // revenue hidden from this viewer
];

describe("salesmen and referrers, apart", () => {
  it("a job with both is a salesman line and a referrer line", () => {
    const j1 = LINES.filter((l) => l.job_id === "j1").map((l) => l.payee_kind);
    expect(j1.sort()).toEqual(["referrer", "salesman"]);
  });

  it("filters to one kind", () => {
    expect(filterByKind(LINES, "salesman").every((l) => l.payee_kind === "salesman")).toBe(true);
    expect(filterByKind(LINES, "referrer")).toHaveLength(3);
    expect(filterByKind(LINES, "all")).toHaveLength(6);
  });

  it("subtotals per salesman and per referring company, salesmen first", () => {
    const rows = rollUpByPayee(LINES);
    expect(
      rows.map((r) => [r.payee_kind, r.payee, r.jobs, r.earned, r.paid, r.outstanding, r.unknown]),
    ).toEqual([
      ["salesman", "Avi Rep", 2, 900, 300, 600, 0],
      ["salesman", "Bea Rep", 1, 200, 0, 200, 0],
      // 8% of 10,000 outstanding on j1, 750 paid on j2, j4's amount not visible.
      ["referrer", "Acme Brokers", 3, 1550, 750, 800, 1],
    ]);
  });

  it("totals paid and outstanding, and never guesses a hidden amount", () => {
    expect(commissionKpiTotals(LINES)).toEqual({
      earned: 2650,
      paid: 1050,
      outstanding: 1600,
      unknown: 1,
    });
  });

  it("lists each line with its deal and paid / outstanding", () => {
    const rows = lineRows(LINES);
    expect(rows[0]).toMatchObject({
      payee_kind: "salesman",
      payee: "Avi Rep",
      deal: "10% of collected",
      owed: 600,
      status: "Outstanding",
    });
    const paidRef = rows.find((r) => r.payee_kind === "referrer" && r.status === "Paid")!;
    expect(paidRef).toMatchObject({
      job_number: "J2",
      deal: "8% of revenue · the company's rule",
      paid_on: "2026-10-05",
      paid_amount: 750,
    });
  });
});

describe("the Excel export", () => {
  it("carries a Payee type column in both views, with money typed as money", () => {
    for (const view of ["payees", "lines"] as const) {
      const cols = reportExportColumns(commissionColumns(view));
      expect(cols[0]).toMatchObject({ key: "payee_kind", label: "Payee type" });
      const rows = view === "lines" ? lineRows(LINES) : rollUpByPayee(LINES);
      const kinds = rows.map((r) => cols[0]!.get(r as unknown as Record<string, unknown>));
      expect(new Set(kinds)).toEqual(new Set(["Salesman", "Referrer"]));
    }
    const lineCols = reportExportColumns(commissionColumns("lines"));
    expect(lineCols.find((c) => c.key === "owed")!.type).toBe("money");
    expect(lineCols.map((c) => c.label)).toEqual([
      "Payee type",
      "Payee",
      "Is a",
      "Job",
      "Deal",
      "Owed",
      "Status",
      "Paid on",
      "Paid",
    ]);
  });
});

describe("the switches", () => {
  const opts = commissionsReport.options!;

  it("offers All / Salesmen / Referrers and By payee / Lines, defaulting to All, By payee", () => {
    expect(opts.map((o) => o.choices.map((c) => c.label))).toEqual([
      ["All", "Salesmen", "Referrers"],
      ["By payee", "Lines"],
    ]);
    expect(parseReportOptions(undefined, opts)).toEqual({ kind: "all", view: "payees" });
  });

  it("round-trips through the URL and drops anything stale", () => {
    const v = { kind: "referrer", view: "lines" };
    expect(formatReportOptions(v, opts)).toBe("kind:referrer,view:lines");
    expect(parseReportOptions("kind:referrer,view:lines", opts)).toEqual(v);
    expect(parseReportOptions("kind:bogus,nope:1", opts)).toEqual({ kind: "all", view: "payees" });
    expect(formatReportOptions({ kind: "all", view: "payees" }, opts)).toBeUndefined();
  });
});
