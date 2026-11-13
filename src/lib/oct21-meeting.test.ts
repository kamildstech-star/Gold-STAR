import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { selectedInOrder } from "@/lib/document-print-selection";
import { filterPickable, mergeAttachmentLinks } from "@/lib/email-attachments";
import { buildCsv, buildXlsx, type ExportSheet } from "@/lib/export-table";
import { cleanSiteName, jobSearchOr, siteNamesLine } from "@/lib/job-site-names";
import { reportTotalsRow, totalsColumns } from "@/lib/report-totals";
import type { Col } from "@/lib/reports-engine";
import {
  DAILY_FIELD_FORMS_FOLDER,
  dailyFolderNames,
  ensureDailyFieldFormsFolder,
} from "@/lib/tm-forms";

/*
 * Client meeting, 21 Oct (David). One file for the items whose rules are
 * small enough to pin here; the larger pieces have their own tests
 * (invoice-review, referrer-name, job-address-correction).
 */
const read = (f: string) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");

describe("3 · building, facility and community names", () => {
  it("blank is null, and the line joins what is set", () => {
    expect(cleanSiteName("  ")).toBeNull();
    expect(
      siteNamesLine({ facility_name: "Sunrise NH", building_name: " ", community: "Oaks" }),
    ).toBe("Sunrise NH · Oaks");
    expect(siteNamesLine({})).toBeNull();
  });

  it("search matches the site names, and drops them before the migration", () => {
    expect(jobSearchOr("oak", true)).toContain("facility_name.ilike.%oak%");
    expect(jobSearchOr("oak", true)).toContain("community.ilike.%oak%");
    expect(jobSearchOr("oak", false)).not.toContain("community");
    expect(jobSearchOr("a,b(c)", false)).not.toMatch(/[(),]b/);
  });

  it("the new job's insert never names the new columns", () => {
    const page = read("src/routes/_authenticated/jobs.new.tsx");
    const insert = page.slice(
      page.indexOf('.from("jobs")\n      .insert({'),
      page.indexOf('.select("id, job_number")'),
    );
    expect(insert).not.toMatch(/building_name|facility_name/);
    expect(page).toMatch(/saveJobSiteNames\(data\.id/);
  });
});

describe("4 · one way to add a referrer", () => {
  it("has no separate New button in the person-first picker", () => {
    const picker = read("src/components/company-contact-picker.tsx");
    const branch = picker.slice(
      picker.indexOf("if (personFirst) {"),
      picker.indexOf('return (\n    <div className="grid gap-2 rounded-md border p-3">'),
    );
    expect(branch).not.toMatch(/<Plus className="mr-1 size-3\.5" \/> New/);
    expect(branch).toMatch(/data-add-contact/);
  });
});

describe("5 · daily folders for every job that files daily tickets", () => {
  it("T&M keeps its three; every other job gets Daily Field Forms", () => {
    expect(dailyFolderNames(true)).toEqual([
      "Daily Sign-In",
      "Daily Crew Chief",
      "Daily Supply List",
    ]);
    expect(dailyFolderNames(false)).toEqual([DAILY_FIELD_FORMS_FOLDER]);
  });

  it("makes the one folder, and never throws", async () => {
    const ensure = vi.fn().mockResolvedValue(null);
    await ensureDailyFieldFormsFolder({ locationId: "l", jobId: "j" }, "u", ensure);
    expect(ensure).toHaveBeenCalledWith({
      scope: { locationId: "l", jobId: "j" },
      name: "Daily Field Forms",
      userId: "u",
    });
    const refuse = vi.fn().mockRejectedValue(new Error("rls"));
    await expect(
      ensureDailyFieldFormsFolder({ locationId: "l", jobId: "j" }, "u", refuse),
    ).resolves.toBeUndefined();
  });

  it("the job page asks for it on ticket jobs", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    expect(page).toMatch(/fieldTicketJob=\{fieldForms\.ticket === "full"\}/);
  });
});

describe("6 · bulk print", () => {
  it("prints the ticked documents in list order — images too (12 Nov) — skipping gone ids", () => {
    const rows = [
      { id: "a", name: "a.pdf", mime: "application/pdf" },
      { id: "b", name: "b.jpg", mime: "image/jpeg" },
      { id: "c", name: "c.pdf", mime: null },
    ];
    expect(selectedInOrder(rows, new Set(["c", "b", "a", "gone"])).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("goes through the folder merge, not a second merger", () => {
    const panel = read("src/components/documents-panel.tsx");
    expect(panel.match(/mergeFolderPdf\(/g)?.length).toBe(1);
    expect(panel).toMatch(/Print \$\{printPick\.size\} selected/);
  });
});

describe("7 · contracts default to email", () => {
  it("email is the primary button; signing on site is outline", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    const box = page.slice(
      page.indexOf("Contract — service agreement"),
      page.indexOf("presetDocTypes"),
    );
    expect(box).toMatch(/<Button\s+variant="outline"\s+asChild[\s\S]*Sign on site/);
    expect(box).toMatch(/Email contract to sign/);
  });
});

describe("8 · attachments from the job and the company", () => {
  it("only stored files, matched by name", () => {
    const rows = [
      { name: "W-9 2026.pdf", storage_path: "x" },
      { name: "COI.pdf", storage_path: null },
    ];
    expect(filterPickable(rows, "w-9").map((r) => r.name)).toEqual(["W-9 2026.pdf"]);
    expect(filterPickable(rows, "")).toHaveLength(1);
  });

  it("keeps the caller's file first and never sends one twice", () => {
    const inv = { label: "Invoice", url: "u1" };
    expect(
      mergeAttachmentLinks(
        [inv],
        [
          { label: "W-9", url: "u2" },
          { label: "dup", url: "u1" },
        ],
      ),
    ).toEqual([inv, { label: "W-9", url: "u2" }]);
  });

  it("the composer offers both sources", () => {
    const picker = read("src/components/email-attachment-picker.tsx");
    expect(picker).toMatch(/listCompanyDocuments/);
    expect(picker).toMatch(/listDocuments\(scope\)/);
    expect(read("src/components/job-email-dialog.tsx")).toMatch(/<EmailAttachmentPicker/);
  });
});

describe("11 · invoice layout", () => {
  it("editor: description above the lines, closing statement below", () => {
    const ed = read("src/components/invoice-editor.tsx");
    const desc = ed.indexOf('<CardTitle className="text-sm">Description</CardTitle>');
    const scopes = ed.indexOf("<InvoiceScopeCard");
    const closing = ed.indexOf('<CardTitle className="text-sm">Closing statement</CardTitle>');
    expect(desc).toBeGreaterThan(-1);
    expect(desc).toBeLessThan(scopes);
    expect(closing).toBeGreaterThan(scopes);
  });

  it("PDF: description before the line table, closing statement after the totals", () => {
    const pdf = read("src/lib/invoice-pdf.ts");
    expect(pdf.indexOf('sectionLabel("Description")')).toBeLessThan(pdf.indexOf("s.totals("));
    expect(pdf.indexOf('sectionLabel("Closing statement")')).toBeGreaterThan(
      pdf.indexOf("s.totals("),
    );
  });
});

describe("13 · scanner", () => {
  it("a bigger camera, and a whole typed tag needs no second tap", () => {
    const sc = read("src/components/asset-tag-scanner.tsx");
    expect(sc).toMatch(/h-\[min\(55svh,34rem\)\]/);
    expect(sc).toMatch(/normalizeAssetTag\(value\) === null\) return;/);
  });
});

describe("14 · totals on top, frozen headers", () => {
  const cols: Col[] = [
    { key: "job", label: "Job", get: (r) => r.job },
    { key: "billed", label: "Billed", num: true, fmt: "usd", get: (r) => r.billed },
    { key: "paid", label: "Paid", num: true, fmt: "usd", get: (r) => r.paid },
    { key: "status", label: "Status", get: (r) => r.status },
  ];
  const rows = [
    { job: "J1", billed: 100.1, paid: null, status: "open" },
    { job: "J2", billed: 50, paid: null, status: "open" },
  ];

  it("sums the money columns; an untracked one stays blank, not $0", () => {
    const t = reportTotalsRow(cols, rows, "Totals (2 jobs)");
    expect(t).toEqual({ job: "Totals (2 jobs)", billed: 150.1 });
    expect(totalsColumns(cols)[0]!.get(t)).toBe("Totals (2 jobs)");
  });

  it("writes the totals above the header and freezes both", () => {
    const sheet: ExportSheet = {
      name: "Ledger",
      headers: ["Job", "Billed"],
      types: [undefined, "money"],
      rows: [
        ["J1", 100],
        ["J2", 50],
      ],
      totals: ["Totals", 150],
    };
    const files = unzipSync(buildXlsx([sheet]));
    const xml = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(xml).toMatch(/<pane ySplit="2" topLeftCell="A3"/);
    expect(xml.indexOf('<row r="1">')).toBeLessThan(xml.indexOf("Billed"));
    expect(xml).toMatch(/<autoFilter ref="A2:B4"\/>/);
    expect(buildCsv(sheet).split("\n")[0]).toBe("Totals,150");
  });

  it("a sheet without totals is unchanged", () => {
    const xml = strFromU8(
      unzipSync(buildXlsx([{ name: "S", headers: ["A"], types: [undefined], rows: [["x"]] }]))[
        "xl/worksheets/sheet1.xml"
      ]!,
    );
    expect(xml).toMatch(/<pane ySplit="1" topLeftCell="A2"/);
    expect(xml).toMatch(/<autoFilter ref="A1:A2"\/>/);
  });

  it("the job ledger report carries totals, and the report table scrolls under its header", () => {
    expect(read("src/lib/job-ledger-report.ts")).toMatch(/totals: reportTotalsRow\(columns, rows/);
    const view = read("src/components/report-view.tsx");
    expect(view).toMatch(/md:max-h-\[75svh\] md:overflow-auto \[--table-sticky-top:0px\]/);
    expect(view).toMatch(/data-report-totals/);
  });
});
