// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { ReportOptionsBar } from "./report-options-bar";
import { commissionsReport } from "@/lib/commissions-report";

/**
 * Mark, 7 Oct: "and reports, it needs to be able to separate salesman and
 * referrers." The commissions report's switches, rendered, and the page
 * handing them to the report.
 */
describe("the report's switches", () => {
  const html = renderToStaticMarkup(
    createElement(ReportOptionsBar, {
      options: commissionsReport.options!,
      values: { kind: "salesman", view: "payees" },
      onChange: () => {},
    }),
  );

  it("shows Show and View as radio groups with the chosen one checked", () => {
    expect(html.match(/role="radiogroup"/g)).toHaveLength(2);
    const checked = [...html.matchAll(/aria-checked="true"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(checked).toEqual(["Salesmen", "By payee"]);
  });

  it("is a 44px target on a phone and wraps instead of scrolling sideways", () => {
    const btn = html.match(/<button[^>]*>Referrers<\/button>/)![0];
    expect(btn).toContain("h-11");
    const box = html.match(/<div[^>]*data-report-options[^>]*>/)![0];
    expect(box).toContain("flex-wrap");
    expect(html).not.toContain("overflow-x-auto");
  });

  it("the Reports page passes the switches to the report and clears them on a new report", () => {
    const page = readFileSync("src/routes/_authenticated/reports.index.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    expect(page).toMatch(/locationNames,\s*options,\s*\}\)/);
    expect(page).toContain("r: id, opt: undefined");
    expect(page).toContain("<ReportOptionsBar options={report.options}");
  });
});
