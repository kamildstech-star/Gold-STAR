import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  blankTmFormPdf,
  clock12,
  fillCrewChiefPdf,
  fillSignInPdf,
  fillSupplyListPdf,
  paperDate,
  winAnsi,
} from "@/lib/tm-forms-pdf";
import { SUPPLY_LIST_LAYOUT } from "@/lib/tm-forms-layout";
import {
  TM_FORM_META,
  type CrewChiefPayload,
  type SignInPayload,
  type SignInRow,
  type SupplyListPayload,
} from "@/lib/tm-forms";
import { TM_RATE_CODES_COMPILED, type TmRateCode } from "@/lib/tm-rate-codes";

/**
 * The filled sheets, built from fixtures and read back with a parser: the
 * page is US Letter, the original sheet is underneath (its logo image and
 * text are still in the file), and the crew's entries are in the content.
 *
 * Set TM_FORMS_SAMPLE_DIR=<dir> to keep the files and look at them.
 */

const template = (kind: keyof typeof TM_FORM_META) =>
  new Uint8Array(readFileSync(join("public", TM_FORM_META[kind].template)));

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
    } catch {
      // An image stream.
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
  );
}

async function pages(bytes: Uint8Array) {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => p.getSize());
}

function keep(name: string, bytes: Uint8Array) {
  const dir = process.env.TM_FORMS_SAMPLE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), bytes);
}

const SIG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAAkCAYAAABCKP5eAAABc0lEQVR42u2Z0RGDIBBElUkBFpE2Ur1tpIh0YL4ycRgDHByLGd/7y0RZveW4Q6YJAAAAAAAA4DrMvQWW+2Pb/34911mh11vn0gbHpsZ4B/9ID4MFBsdB3hvhZcDRmGTxl6BcInsGHDNFBueCHWdZj1LgqfHv3JS1d2+AZ/BHZK+67ucms6QGL/fHVvqSrXUyd3+P7t0yKZV6Ka155PbEMiFq7/Vq7ErHUeqVXBNGNzo1S3VtJnmUhdw7euiVTpLPf6lrgrL2jqqdrUG33tOiZ10BcteEIwF192nRq63dtUGvXXJbVzOvyR9aH+yfPipYTe5RT5XmJpdoVRZb9qwek6nUZI+AK7VMBqu2OmfNZM+AK7VM26QS8zwNLtXzDILyUER9AFPcRf96sDM3Yq2N0Ou5zt4BT405bAVMddTe3fZnvLNMqOlKhw1xcJXZhLkdDT5qEHo3BbEG5goO/JUnJ7WnJtB42KDI3JF6AAAAAAAAcAne/vleQlkA01YAAAAASUVORK5CYII=";

const row = (i: number, over: Partial<SignInRow> = {}): SignInRow => ({
  id: `r${i}`,
  userId: null,
  employee: `Crew Member ${i}`,
  rateCode: "GL",
  timeIn: "07:00",
  lunchStart: "12:00",
  lunchEnd: "12:30",
  timeOut: "15:30",
  lodging: "",
  signature: SIG,
  signedAt: "2026-10-07T19:30:00Z",
  ...over,
});

const LETTER = { width: 612, height: 792 };

describe("plain helpers", () => {
  it("prints times and dates the way the office writes them", () => {
    expect(clock12("07:05")).toBe("7:05 AM");
    expect(clock12("12:30")).toBe("12:30 PM");
    expect(clock12("00:15")).toBe("12:15 AM");
    expect(clock12("")).toBe("");
    expect(paperDate("2026-10-07")).toBe("10/07/2026");
  });

  it("keeps Spanish names and drops what Helvetica cannot draw", () => {
    expect(winAnsi("José Peña – “jefe”")).toBe('José Peña - "jefe"');
    expect(winAnsi("Crew 👷 one")).toBe("Crew  one");
  });
});

describe("Crew Sign In/Out Sheet PDF", () => {
  it("is the original sheet with every entry and a signature image per row", async () => {
    const payload: SignInPayload = {
      jobName: "Marriott Riverside – Tower B",
      jobLocation: "100 River Rd, Newark, NJ 07102",
      rows: [
        row(1, { employee: "José Peña", rateCode: "CCF", lodging: "hotel_per_diem" }),
        row(2, {
          employee: "Dana Smith",
          rateCode: "WE3",
          timeIn: "06:45",
          timeOut: "17:15",
          // The toggle's own answer (David, 12 Oct); the two above are legacy.
          lodging: "yes",
        }),
        row(3, { employee: "Temp – Luis", rateCode: "TL", signature: null, lodging: "per_diem" }),
      ],
      removed: [],
    };
    const bytes = await fillSignInPdf(payload, "2026-10-07", template("sign_in"));
    keep("crew-sign-in-sheet.pdf", bytes);
    expect(await pages(bytes)).toEqual([LETTER]);
    const text = await pdfText(bytes);
    for (const s of [
      "Marriott Riverside - Tower B",
      "100 River Rd, Newark, NJ 07102",
      "10/07/2026",
      "José Peña",
      "CCF",
      "WE3",
      "6:45 AM",
      "5:15 PM",
      "12:30 PM",
      "Hotel+PD",
      "PD",
      "Yes",
      "Temp - Luis",
    ]) {
      expect(text).toContain(s);
    }
    // The original's own heading is still in the file — the sheet is underneath.
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPage(0).node.Resources()).toBeTruthy();
    // Two signatures were drawn (the third row has none).
    expect((text.match(/\/Image\b/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("continues a crew longer than 36 on another copy of the sheet", async () => {
    const payload: SignInPayload = {
      jobName: "Big job",
      jobLocation: "Somewhere",
      rows: Array.from({ length: 40 }, (_, i) => row(i + 1, { signature: null })),
      removed: [],
    };
    const bytes = await fillSignInPdf(payload, "2026-10-07", template("sign_in"));
    expect(await pages(bytes)).toEqual([LETTER, LETTER]);
    const text = await pdfText(bytes);
    expect(text).toContain("Crew Member 40");
    expect(text).toContain("Page 2 of 2");
  });

  it("prints a blank sheet when nobody has signed yet", async () => {
    const bytes = await fillSignInPdf(
      { jobName: "J", jobLocation: "L", rows: [], removed: [] },
      "2026-10-07",
      template("sign_in"),
    );
    expect(await pages(bytes)).toEqual([LETTER]);
  });
});

describe("Daily Crew Chief PDF", () => {
  const payload: CrewChiefPayload = {
    jobName: "Marriott Riverside",
    jobLocation: "100 River Rd, Newark, NJ",
    supervisor: "Heshy Gold",
    workZone: "Floors 3-5, east wing",
    crewChief: "José Peña",
    crewNumber: "2",
    crewSize: "7",
    staff: [
      "Dana Smith",
      "Luis Ortega",
      "Ana Ruiz",
      "Sam Lee",
      "Kim Park",
      "Ali Khan",
      "Bo Chen",
      "",
      "",
      "",
      "",
      "",
    ],
    notes:
      "Extracted standing water on 3rd floor corridor and rooms 301-318. Set 12 air movers and 3 dehus. Removed wet carpet pad in 305 and 307.\nCustomer asked for daily photos.",
  };

  it("fills the bilingual sheet and keeps every note", async () => {
    const bytes = await fillCrewChiefPdf(payload, "2026-10-07", template("crew_chief"));
    keep("daily-crew-chief-report.pdf", bytes);
    expect(await pages(bytes)).toEqual([LETTER]);
    const text = await pdfText(bytes);
    for (const s of [
      "Heshy Gold",
      "Floors 3-5, east wing",
      "José Peña",
      "Bo Chen",
      "Customer asked for daily photos.",
      "10/07/2026",
    ]) {
      expect(text).toContain(s);
    }
  });

  it("puts notes the lines cannot hold on a continuation page", async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of the day's notes.`).join(
      "\n",
    );
    const bytes = await fillCrewChiefPdf(
      { ...payload, notes: long },
      "2026-10-07",
      template("crew_chief"),
    );
    expect((await pages(bytes)).length).toBe(2);
    const text = await pdfText(bytes);
    expect(text).toContain("Line 40 of the day's notes.");
    expect(text).toContain("(continued)");
  });
});

describe("Daily Supply List PDF", () => {
  it("writes each quantity in its code's box and nothing in the others", async () => {
    const payload: SupplyListPayload = {
      jobName: "Marriott Riverside",
      jobLocation: "100 River Rd, Newark, NJ",
      totalCrew: "7",
      lines: [
        { code: "CCF", qty: 1 },
        { code: "GL", qty: 6 },
        { code: "103", qty: 4 },
        { code: "302", qty: 12 },
        { code: "311", qty: 3 },
        { code: "205", qty: 2 },
        { code: "401", qty: 1 },
        { code: "GEN-PERDIEM", qty: 7 },
        { code: "150", qty: 2.5 },
      ],
    };
    const bytes = await fillSupplyListPdf(
      payload,
      "2026-10-07",
      template("supply_list"),
      TM_RATE_CODES_COMPILED,
    );
    keep("daily-supply-list.pdf", bytes);
    expect(await pages(bytes)).toEqual([LETTER]);
    const text = await pdfText(bytes);
    for (const s of ["Marriott Riverside", "10/07/2026", "12", "2.5"]) expect(text).toContain(s);
  });

  it("has a Quantity box for every code on the printed sheet", () => {
    for (const c of TM_RATE_CODES_COMPILED) {
      expect(SUPPLY_LIST_LAYOUT.quantity[c.code], c.code).toBeDefined();
    }
  });

  it("lists a code added after the sheet was printed on an extra page", async () => {
    const added: TmRateCode = {
      code: "157",
      label: "Floor protection film",
      section: "consumable",
      unit_note: null,
      sort_order: 580,
      active: true,
    };
    const bytes = await fillSupplyListPdf(
      { jobName: "J", jobLocation: "L", totalCrew: "", lines: [{ code: "157", qty: 3 }] },
      "2026-10-07",
      template("supply_list"),
      [...TM_RATE_CODES_COMPILED, added],
    );
    expect((await pages(bytes)).length).toBe(2);
    expect(await pdfText(bytes)).toContain("Floor protection film");
  });
});

describe("Blank PDFs with fillable boxes", () => {
  it.each(["sign_in", "crew_chief", "supply_list"] as const)(
    "%s: the original sheet, letter size, with AcroForm text fields",
    async (kind) => {
      const bytes = await blankTmFormPdf(kind, template(kind));
      keep(`${TM_FORM_META[kind].fileStem}-blank.pdf`, bytes);
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPages().map((p) => p.getSize())).toEqual([LETTER]);
      const names = doc
        .getForm()
        .getFields()
        .map((f) => f.getName());
      expect(names).toContain("job_name");
      expect(names).toContain("date");
      if (kind === "sign_in") {
        expect(names).toContain("employee_36");
        expect(names).toContain("rate_code_1");
        expect(names.some((n) => n.startsWith("signature"))).toBe(false);
      }
      if (kind === "crew_chief") {
        expect(names).toContain("crew_staff_12");
        expect(names).toContain("daily_work_notes");
      }
      if (kind === "supply_list") {
        expect(names.filter((n) => n.startsWith("qty_"))).toHaveLength(157);
        expect(names).toContain("total_crew_amount");
      }
    },
  );
});
