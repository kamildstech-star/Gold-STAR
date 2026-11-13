import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TIME_OUT,
  applySupplyScan,
  fillMissingTimes,
  missingTimes,
  paperScanDocName,
  paperScanFilename,
  scannedHours,
} from "@/lib/paper-scan";
import { applyScan, type ScannedRow } from "@/lib/sign-in-scan";
import { parseSupplyModelOutput } from "@/lib/supply-sheet-scan";
import { buildTmBill, type PricedCode } from "@/lib/tm-bill";
import {
  mergePaperScans,
  mergeSignIn,
  normaliseSignIn,
  normaliseSupplyList,
  rowSigned,
  type SignInPayload,
} from "@/lib/tm-forms";

/*
 * 12 Nov: paper sign-in and supply sheets uploaded beside the day — the
 * paper's own date, the missing times asked for (5 PM by default), no
 * duplicates, the PDF in Documents, and the hours on the T&M bill.
 */
const scanned = (over: Partial<ScannedRow>): ScannedRow => ({
  employee: "Gutierrez, Rose",
  rateCode: "DL",
  timeIn: "09:00",
  lunchStart: "",
  lunchEnd: "",
  timeOut: "",
  lodging: false,
  signed: true,
  ...over,
});
const HASH = "a".repeat(64);

describe("the paper's own date names the scan", () => {
  it("in the Documents name and the file name", () => {
    expect(paperScanDocName("sign_in", "2026-11-09")).toBe(
      "Crew Sign In/Out Sheet (paper scan) - 11/09/2026",
    );
    expect(paperScanFilename("sign_in", "2026-11-09", "2609221")).toBe(
      "crew-sign-in-sheet-paper-2609221-2026-11-09.pdf",
    );
    expect(paperScanFilename("supply_list", "2026-11-09", null)).toBe(
      "daily-supply-list-paper-2026-11-09.pdf",
    );
  });
});

describe("missing times on the paper", () => {
  const rows = [
    scanned({ timeOut: "17:20", lunchStart: "12:00", lunchEnd: "12:30" }),
    scanned({ employee: "Lopez, Yordi" }),
    scanned({ employee: "Blank", timeIn: "" }),
  ];

  it("are found per row", () => {
    expect(missingTimes(rows)).toEqual({ noOut: [1], noLunch: [1], noIn: [2] });
  });

  it("take 5 PM for a missing time out, and a lunch only when one is given", () => {
    const [a, b, c] = fillMissingTimes(rows, {
      timeOut: DEFAULT_TIME_OUT,
      lunchStart: "",
      lunchEnd: "",
    });
    expect(a).toEqual(rows[0]); // what the paper says is never changed
    expect(b).toMatchObject({ timeOut: "17:00", lunchStart: "", lunchEnd: "" });
    expect(c).toEqual(rows[2]); // no time in: nothing to bill from
    const withLunch = fillMissingTimes(rows, {
      timeOut: "17:00",
      lunchStart: "12:00",
      lunchEnd: "12:30",
    });
    expect(withLunch[1]).toMatchObject({ lunchStart: "12:00", lunchEnd: "12:30" });
    expect(scannedHours(withLunch.slice(0, 2))).toBe(15.33);
  });

  it("a 5 written after a 9 AM start is the afternoon", () => {
    const [r] = fillMissingTimes([scanned({})], { timeOut: "05:00", lunchStart: "", lunchEnd: "" });
    expect(r!.timeOut).toBe("17:00");
  });
});

describe("rows signed on the paper", () => {
  const empty: SignInPayload = { jobName: "", jobLocation: "", rows: [], removed: [] };
  let n = 0;
  const opts = { newId: () => `id${++n}`, people: [], codes: new Set(["DL", "CCF"]) };

  it("count as signed, and survive a save and a two-phone merge", () => {
    const { sheet } = applyScan(empty, [scanned({ timeOut: "17:00" })], opts);
    expect(sheet.rows[0]!.paperSigned).toBe(true);
    expect(rowSigned(sheet.rows[0]!)).toBe(true);
    const round = normaliseSignIn(JSON.parse(JSON.stringify(sheet)));
    expect(round.rows[0]!.paperSigned).toBe(true);
    expect(mergeSignIn(round, { ...round, rows: [] }).rows[0]!.paperSigned).toBe(true);
  });

  it("are billed on the T&M bill without a phone signature", () => {
    const { sheet } = applyScan(
      empty,
      [scanned({ timeOut: "17:00", lunchStart: "12:00", lunchEnd: "12:30" })],
      opts,
    );
    const codes: PricedCode[] = [
      { code: "DL", label: "Demolition Labor", section: "labor", rate: 60 },
    ];
    const bill = buildTmBill({
      range: { from: "2026-11-09", to: "2026-11-15" },
      signIns: [{ date: "2026-11-09", payload: sheet }],
      supplies: [],
      equipment: [],
      codes,
      includeUnsigned: false,
    });
    expect(bill.labor).toHaveLength(1);
    expect(bill.labor[0]).toMatchObject({ date: "2026-11-09", regular: 7.5 });
    expect(bill.unsignedExcluded).toEqual([]);
  });

  it("left unticked stay unsigned", () => {
    const { sheet } = applyScan(empty, [scanned({ signed: false })], opts);
    expect(rowSigned(sheet.rows[0]!)).toBe(false);
  });
});

describe("the same photo twice", () => {
  it("is remembered on the sheet, through every save path", () => {
    const scans = [{ hash: HASH, documentId: "doc1", at: "2026-11-12T10:00:00Z" }];
    const signIn = normaliseSignIn({ rows: [], removed: [], paperScans: scans });
    expect(signIn.paperScans).toEqual(scans);
    // A sheet opened on a phone before the scan landed keeps the record.
    expect(mergeSignIn(signIn, { ...signIn, paperScans: undefined }).paperScans).toEqual(scans);
    expect(normaliseSupplyList({ lines: [], paperScans: scans }).paperScans).toEqual(scans);
    // Junk is dropped; an old sheet has no field at all.
    expect(
      normaliseSignIn({ rows: [], paperScans: [{ hash: "nope" }] }).paperScans,
    ).toBeUndefined();
    expect(mergePaperScans(scans, [{ hash: HASH, documentId: null, at: "" }])).toEqual(scans);
  });

  it("is looked up on the job before the model is paid to read it", () => {
    const src = readFileSync("src/components/paper-scan-upload.tsx", "utf8");
    expect(src.indexOf("findPaperScan(")).toBeGreaterThan(0);
    expect(src.indexOf("findPaperScan(")).toBeLessThan(src.indexOf("sheetDataUrl(file)"));
    // Filed as a PDF in Documents, not as a picture.
    expect(src).toContain("photoToPdf(");
    expect(src).toContain('type: "application/pdf"');
  });
});

describe("the paper supply list", () => {
  it("keeps only codes printed on the sheet, with real quantities", () => {
    const sheet = parseSupplyModelOutput(
      '```json\n{"date":"2026-11-09","total_crew":"7 ppl","lines":[{"code":"dl","qty":3},{"code":"104","qty":"2"},{"code":"ZZZ","qty":5},{"code":"PM","qty":0}]}\n```',
    );
    expect(sheet).toEqual({
      date: "2026-11-09",
      totalCrew: "7",
      lines: [
        { code: "DL", qty: 3 },
        { code: "104", qty: 2 },
      ],
    });
    expect(parseSupplyModelOutput("no json")).toBeNull();
  });

  it("fills the day's sheet without overwriting what was typed", () => {
    const { sheet, added } = applySupplyScan(
      { jobName: "", jobLocation: "", totalCrew: "", lines: [{ code: "DL", qty: 1 }] },
      [
        { code: "DL", qty: 3 },
        { code: "104", qty: 2 },
      ],
      "7",
    );
    expect(added).toBe(1);
    expect(sheet.totalCrew).toBe("7");
    expect(sheet.lines).toEqual([
      { code: "DL", qty: 1 },
      { code: "104", qty: 2 },
    ]);
  });
});

describe("the Field Form header", () => {
  it("has the paper uploads beside the day, and the sign-in dialog no longer scans", () => {
    const src = readFileSync("src/components/tm-field-forms-panel.tsx", "utf8");
    expect(src).toContain("data-tm-day-bar");
    expect(src).toContain("<PaperScanUpload");
    expect(src).not.toContain("SignInScan");
  });
});
