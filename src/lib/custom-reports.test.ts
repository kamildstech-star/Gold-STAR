import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  CUSTOM_AREAS,
  CUSTOM_ROW_LIMIT,
  blankDefinition,
  describeDefinition,
  likePattern,
  sanitizeDefinition,
  selectColumns,
  shapeCustomResult,
} from "./custom-reports";

/**
 * David, 22 Sep: "How do we create a new report? If I want to just randomly go
 * in there and create different filters and different stuff to run a new
 * report... maybe add another section here, custom report."
 */

const lookups = {
  officeName: (id: unknown) => (id === "lw" ? "LW · Lakewood" : "Unassigned"),
  statusName: (v: unknown) => (v === "st1" ? "Invoice pending payment" : String(v)),
};

describe("the data areas", () => {
  it("are the ones the preset reports already read, and nothing freer", () => {
    expect(CUSTOM_AREAS.map((a) => a.table)).toEqual([
      "jobs",
      "invoices",
      "supply_purchases",
      "accounts",
    ]);
  });

  it("each has a default column set drawn from its own fields", () => {
    for (const a of CUSTOM_AREAS) {
      const keys = new Set(a.fields.map((f) => f.key));
      for (const c of a.defaultColumns) expect(keys.has(c), `${a.id}.${c}`).toBe(true);
      expect(a.dateFields.length).toBeGreaterThan(0);
    }
  });
});

describe("a saved definition is made safe to run", () => {
  it("drops unknown columns, filters and date fields rather than querying them", () => {
    const d = sanitizeDefinition({
      area: "jobs",
      dateField: "drop table",
      columns: ["job_number", "password_hash"],
      text: { insurance_carrier: " State Farm ", secret: "x", job_number: "12" },
      statuses: ["st1"],
    });
    expect(d.dateField).toBe("created_at");
    expect(d.columns).toEqual(["job_number"]);
    // job_number is a column but not a text filter.
    expect(d.text).toEqual({ insurance_carrier: "State Farm" });
    expect(d.statuses).toEqual(["st1"]);
  });

  it("falls back to the first area and its defaults for junk", () => {
    expect(sanitizeDefinition(null)).toEqual(blankDefinition("jobs"));
    expect(sanitizeDefinition({ area: "nope" }).area).toBe("jobs");
  });

  it("drops statuses for an area without a status", () => {
    expect(sanitizeDefinition({ area: "purchasing", statuses: ["x"] }).statuses).toEqual([]);
  });
});

describe("running", () => {
  it("reads only what is shown, filtered and linked", () => {
    const d = {
      ...blankDefinition("billing"),
      columns: ["invoice_number"],
      text: { carrier: "x" },
    };
    expect(selectColumns(d)).toEqual([
      "id",
      "job_id",
      "location_id",
      "status",
      "invoice_number",
      "carrier",
      "issue_date",
    ]);
  });

  it("treats % and _ typed into a filter as text", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%");
  });

  it("shapes rows into the ReportView table with office and stage names", () => {
    const def = {
      ...blankDefinition("jobs"),
      columns: ["job_number", "stage_id", "billed_amount", "location_id"],
    };
    const out = shapeCustomResult(
      def,
      [
        { id: "j1", job_number: "J-1", stage_id: "st1", billed_amount: 100, location_id: "lw" },
        { id: "j2", job_number: "J-2", stage_id: "st1", billed_amount: 50.5, location_id: null },
      ],
      lookups,
    );
    expect(out.columns.map((c) => c.label)).toEqual(["Job #", "Stage", "Billed", "Office"]);
    expect(out.columns[1]!.get(out.rows[0]!)).toBe("Invoice pending payment");
    expect(out.columns[3]!.get(out.rows[1]!)).toBe("Unassigned");
    expect(out.columns[0]!.link!(out.rows[0]!)).toEqual({ to: "/jobs/$id", params: { id: "j1" } });
    expect(out.kpis[0]).toMatchObject({ label: "Jobs", value: 2 });
    expect(out.kpis[1]).toMatchObject({ label: "Billed", value: 150.5, fmt: "usd" });
    expect(out.empty).toBeNull();
  });

  it("says nothing matched instead of drawing an empty table", () => {
    expect(shapeCustomResult(blankDefinition("jobs"), [], lookups).empty).toMatch(
      /Nothing matches/,
    );
  });

  it("says when it stopped at the row limit", () => {
    const rows = Array.from({ length: CUSTOM_ROW_LIMIT }, (_, i) => ({ id: String(i) }));
    expect(shapeCustomResult(blankDefinition("jobs"), rows, lookups).kpis[0]!.note).toMatch(
      /first 2,000/,
    );
  });

  it("describes itself in words", () => {
    expect(
      describeDefinition({
        ...blankDefinition("jobs"),
        statuses: ["a"],
        text: { insurance_carrier: "Allstate" },
      }),
    ).toBe("Jobs by created date in the period · 1 stage value · Carrier contains “Allstate”");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20260926122000_saved_reports.sql");
const LIB = read("src/lib/custom-reports.ts");
const PAGE = read("src/routes/_authenticated/reports.index.tsx");

describe("the office boundary", () => {
  it("applies the page's office selection, and an empty one is deny-all", () => {
    const run = LIB.match(/export async function runCustomReport[\s\S]*?\n\}/)![0];
    expect(run).toContain(
      'ctx.locationIds.length ? ctx.locationIds : ["00000000-0000-0000-0000-000000000000"]',
    );
  });

  it("saves choices only, scoped to the owner or the office it is shared with", () => {
    expect(SQL).toContain("definition jsonb NOT NULL DEFAULT '{}'::jsonb");
    const read = SQL.match(/CREATE POLICY "saved_reports_read"[\s\S]*?\n {2}\);/)![0];
    expect(read).toContain("user_id = (SELECT auth.uid())");
    expect(read).toContain("ELSE public.can_view_location((SELECT auth.uid()), location_id)");
    expect(read).toContain(
      "WHEN location_id IS NULL THEN public.is_privileged((SELECT auth.uid()))",
    );
    const own = SQL.match(/CREATE POLICY "saved_reports_own"[\s\S]*?;/)![0];
    expect(own).toContain("WITH CHECK (user_id = (SELECT auth.uid()))");
  });
});

describe("the Reports page", () => {
  it("has a Custom reports band beside the presets, with saved ones and New", () => {
    expect(PAGE).toContain("Custom reports");
    expect(PAGE).toContain("onClick={() => setReport(`saved:${r.id}`)}");
    expect(PAGE).toContain("New custom report");
  });

  it("draws a custom report with the same ReportView as every preset", () => {
    expect(PAGE).toContain("const report = customReport ?? reportById(search.r);");
    expect(PAGE.match(/<ReportView\b/g)).toHaveLength(1);
  });

  it("leaves the preset catalog untouched", () => {
    expect(PAGE).toContain('{ key: "pulls", label: "Quick pulls" }');
  });
});
