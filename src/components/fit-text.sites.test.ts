import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, from a screenshot of the dashboard where OUTSTANDING A/R read
 * "$394,…": "we need the words to be auto resizing so there are no ...
 * anywhere"
 *
 * Every big number in the app now renders inside <FitText>, which shrinks the
 * text to its box and has no code path that draws an ellipsis. There is no
 * DOM testing library here, so each site is pinned at the source: the value
 * expression must sit inside a <FitText> element, and no <FitText> anywhere
 * may carry `truncate`, which is the class that draws the "…".
 *
 * `value` is a fragment that must appear inside one of the file's FitText
 * elements — the expression that renders the number, not a comment.
 */
const SITES: { file: string; values: string[] }[] = [
  // The shared KPI tile. Behind the dashboard strip, both role dashboards,
  // and every MetricStrip page (billing, director, expenses, profitability…).
  { file: "src/components/metric-stat.tsx", values: ["{value}"] },
  {
    file: "src/components/dashboard-overview-cards.tsx",
    values: ["fmtMoney(r.value)", "fmtMoney(data?.pipelineTotalValue ?? 0)", "fmtMoney(rev)"],
  },
  {
    file: "src/components/running-cost-card.tsx",
    values: ["money(d.companyCost)", "{d.activeJobs}", "marginPct.toFixed(1)"],
  },
  {
    file: "src/components/rep-cost-card.tsx",
    values: ["money(teamCost)", "money(teamRevenue)", "Math.round(teamRatio * 100)", "money(c)"],
  },
  { file: "src/components/dashboard-scorecard.tsx", values: ["{fmt(now)}"] },
  { file: "src/components/goal-progress-card.tsx", values: ["pct(p.attainment)"] },
  {
    file: "src/routes/_authenticated/pipeline.index.tsx",
    // The four KPI tiles are MetricStat (5 Nov), which fits its own numeral.
    values: ["compactMoney(likely)"],
  },
  {
    file: "src/routes/_authenticated/leaderboard.index.tsx",
    values: ["{value}", 'row.points.toLocaleString("en-US")'],
  },
  // Its KPI tiles are MetricStat (5 Nov), which fits its own numeral.
  { file: "src/routes/_authenticated/farming.index.tsx", values: ["{n}"] },
  { file: "src/routes/_authenticated/sales-director.tsx", values: ["{value}", "{s.value}"] },
  { file: "src/components/sales-director/rep-diagnostic.tsx", values: ["{f(value)}"] },
  { file: "src/routes/_authenticated/team-goals.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/my-goals.tsx", values: ["format(actual)"] },
  {
    file: "src/components/job-running-cost-panel.tsx",
    values: [
      "moneyExact(c.total_cost)",
      "moneyExact(c.revenue)",
      "c.margin_pct.toFixed(1)",
      "{value}",
    ],
  },
  { file: "src/components/job-billing-panel.tsx", values: ["{value}"] },
  {
    file: "src/components/job-calculator-editor.tsx",
    values: ["money(pricing.customerPrice)", "money(value)"],
  },
  { file: "src/routes/_authenticated/tradeshows.$id.tsx", values: ["{c.value}"] },
  {
    file: "src/routes/_authenticated/contract.$jobId.tsx",
    values: ["money(contractValue)", "money(job.deductible)"],
  },
  { file: "src/components/report-view.tsx", values: ["fmtValue(k.value, k.fmt)"] },
  { file: "src/routes/_authenticated/chase.jobs.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/chase.performance.tsx", values: ["{k.value}", "{it.value}"] },
  { file: "src/routes/_authenticated/chase.index.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/chase.dispatch.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/chase.search.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/chase.my-performance.tsx", values: ["{value}"] },
  { file: "src/routes/_authenticated/expenses.approvals.tsx", values: ["money(r.amount)"] },
];

function read(file: string): string {
  // The repo checks out CRLF on Windows; an agent worktree may hold LF.
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/** Every <FitText …>…</FitText> element in a file, opening tag included. */
function fitTexts(source: string): string[] {
  return source.match(/<FitText\b[\s\S]*?<\/FitText>/g) ?? [];
}

describe("big numbers render inside <FitText>", () => {
  for (const site of SITES) {
    const source = read(site.file);
    const elements = fitTexts(source);

    it(`${site.file} imports FitText and uses it`, () => {
      expect(source).toContain('from "@/components/ui/fit-text"');
      expect(elements.length).toBeGreaterThanOrEqual(site.values.length);
    });

    for (const value of site.values) {
      it(`${site.file} fits ${value}`, () => {
        const hit = elements.find((el) => el.includes(value));
        expect(hit, `${value} is not inside a <FitText> in ${site.file}`).toBeDefined();
      });
    }

    it(`${site.file} has no truncate on a fitted value`, () => {
      // `truncate` is the class that draws the "…". FitText never needs it,
      // and it would defeat the fit: the box clips before the text shrinks.
      for (const el of elements) expect(el).not.toMatch(/\btruncate\b/);
    });
  }
});

describe("the fit component itself", () => {
  const source = read("src/components/ui/fit-text.tsx");

  it("has no ellipsis anywhere in its markup", () => {
    // The markup only, comments stripped: the prose talks about `truncate`
    // by name, because that is the class this replaces.
    const markup = source
      .slice(source.lastIndexOf("return ("))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(markup).not.toMatch(/\btruncate\b|text-ellipsis|textOverflow/);
  });

  it("scales with a transform, so the line box and its neighbors stay put", () => {
    const style = source.match(/transform: `scale\(\$\{scale\}\)`/);
    expect(style).not.toBeNull();
  });

  it("wraps at the floor instead of clipping", () => {
    // Past the floor the text drops to the floor size for real and breaks
    // wherever it must. Every digit stays on screen.
    const floor = source.match(/fontSize: `\$\{minScale\}em`, overflowWrap: "anywhere"/);
    expect(floor).not.toBeNull();
  });

  it("does not animate, so there is nothing to gate on reduced motion", () => {
    expect(source).not.toMatch(/transition/);
  });
});

describe("a numeric table column never ellipsises", () => {
  it("keeps numbers on one line and lets the table scroll instead", () => {
    const source = read("src/components/data-table.tsx");
    const cell = source.match(/c\.numeric \? "[^"]*" : "truncate"/);
    expect(cell).not.toBeNull();
    expect(cell![0]).toContain("whitespace-nowrap");
    expect(cell![0]).not.toMatch(/"[^"]*truncate[^"]*" : /);
  });
});
