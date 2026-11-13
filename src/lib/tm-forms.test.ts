import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  CREW_STAFF_SLOTS,
  heldPayload,
  jobLocationFor,
  jobNameFor,
  keepQuantities,
  mergeSignIn,
  normaliseCrewChief,
  normaliseSignIn,
  normaliseSupplyList,
  prefillCrewChief,
  prefillSignIn,
  prefillSupplyList,
  sheetDay,
  sortByCatalogue,
  tmFormFilename,
  trimSignIn,
  writeTmForm,
  type ClockSpan,
  type JobFacts,
  type SignInPayload,
  type SignInRow,
  type TmFormWrite,
} from "@/lib/tm-forms";
import { TM_RATE_CODES_COMPILED } from "@/lib/tm-rate-codes";

const JOB: JobFacts = {
  jobNumber: "GS-1042",
  jobName: "Marriott Riverside",
  customerName: "Marriott",
  address: "100 River Rd",
  locality: "Newark",
  region: "NJ",
  postalCode: "07102",
};

const row = (id: string, over: Partial<SignInRow> = {}): SignInRow => ({
  id,
  userId: null,
  employee: id,
  rateCode: "",
  timeIn: "",
  lunchStart: "",
  lunchEnd: "",
  timeOut: "",
  lodging: "",
  signature: null,
  signedAt: null,
  ...over,
});
const sheet = (rows: SignInRow[], removed: string[] = []): SignInPayload => ({
  jobName: "J",
  jobLocation: "L",
  rows,
  removed,
});

/** Local wall-clock time on 2026-10-07, as an ISO instant. */
const at = (hhmm: string, day = "2026-10-07") => new Date(`${day}T${hhmm}:00`).toISOString();

let n = 0;
const ids = () => `id${++n}`;

describe("the job header on every sheet", () => {
  it("names the job by its name, else the customer, else its number", () => {
    expect(jobNameFor(JOB)).toBe("Marriott Riverside");
    expect(jobNameFor({ ...JOB, jobName: null })).toBe("Marriott");
    expect(jobNameFor({ ...JOB, jobName: null, customerName: null })).toBe("GS-1042");
  });

  it("writes the location as an address line", () => {
    expect(jobLocationFor(JOB)).toBe("100 River Rd, Newark, NJ 07102");
    expect(jobLocationFor({ ...JOB, locality: null, region: null, postalCode: null })).toBe(
      "100 River Rd",
    );
  });
});

describe("sign-in sheet: first draft of a new day", () => {
  const crew = [
    { userId: "u-chief", name: "José Peña", role: "crew_chief" },
    { userId: "u-tech", name: "Dana Smith", role: "technician" },
    { userId: "u-pm", name: "Pat Moore", role: "project_manager" },
    { userId: "u-rep", name: "Rae Sales", role: "account_rep" },
  ];
  const spans: ClockSpan[] = [
    // Dana: two labour spans with a gap — the gap is lunch.
    {
      userId: "u-tech",
      name: "Dana Smith",
      startedAt: at("07:02"),
      endedAt: at("11:58"),
      entryType: "labour",
    },
    {
      userId: "u-tech",
      name: "Dana Smith",
      startedAt: at("12:31"),
      endedAt: at("15:30"),
      entryType: "labour",
    },
    // José clocked in first, still on site.
    {
      userId: "u-chief",
      name: "José Peña",
      startedAt: at("06:45"),
      endedAt: null,
      entryType: "labour",
    },
    // Travel is not being on site.
    {
      userId: "u-pm",
      name: "Pat Moore",
      startedAt: at("08:00"),
      endedAt: at("09:00"),
      entryType: "travel",
    },
    // Yesterday's shift is not today's.
    {
      userId: "u-pm",
      name: "Pat Moore",
      startedAt: at("08:00", "2026-10-06"),
      endedAt: at("16:00", "2026-10-06"),
      entryType: "labour",
    },
  ];

  it("lists who clocked in, with their times, then the rest of the site crew", () => {
    const p = prefillSignIn({
      job: JOB,
      day: "2026-10-07",
      spans,
      crew,
      previous: null,
      newId: ids,
    });
    expect(p.jobName).toBe("Marriott Riverside");
    expect(p.jobLocation).toBe("100 River Rd, Newark, NJ 07102");
    expect(p.rows.map((r) => r.employee)).toEqual(["José Peña", "Dana Smith", "Pat Moore"]);
    const [jose, dana, pat] = p.rows;
    expect(jose).toMatchObject({
      userId: "u-chief",
      timeIn: "06:45",
      timeOut: "",
      rateCode: "CCF",
    });
    expect(dana).toMatchObject({
      timeIn: "07:02",
      lunchStart: "11:58",
      lunchEnd: "12:31",
      timeOut: "15:30",
      rateCode: "",
    });
    expect(pat).toMatchObject({ timeIn: "", rateCode: "PM" });
    // The account rep never signs the crew sheet.
    expect(p.rows.some((r) => r.userId === "u-rep")).toBe(false);
  });

  it("carries each person's rate code from the last sheet", () => {
    const previous = sheet([
      row("x", { userId: "u-tech", employee: "Dana Smith", rateCode: "WE3" }),
      row("y", { employee: "Temp Luis", rateCode: "TL" }),
    ]);
    const p = prefillSignIn({ job: JOB, day: "2026-10-07", spans, crew, previous, newId: ids });
    expect(p.rows.find((r) => r.userId === "u-tech")!.rateCode).toBe("WE3");
  });

  it("carries yesterday's crew onto today's sheet, typed-in names too (FE8)", () => {
    const previous = sheet([
      row("x", {
        userId: "u-tech",
        employee: "Dana Smith",
        rateCode: "WE3",
        timeIn: "07:00",
        signature: "data:image/png;base64,AAA",
      }),
      row("y", { employee: "Temp Luis", rateCode: "TL", timeIn: "07:10" }),
      row("z", { employee: "  ", rateCode: "GL" }),
    ]);
    const p = prefillSignIn({
      job: JOB,
      day: "2026-10-08",
      spans: [],
      crew: [],
      previous,
      newId: ids,
    });
    expect(p.rows.map((r) => r.employee)).toEqual(["Dana Smith", "Temp Luis"]);
    // Names and rate codes carry; yesterday's times and signatures never do.
    expect(p.rows[1]).toMatchObject({ userId: null, rateCode: "TL", timeIn: "", signature: null });
    expect(p.rows[0]).toMatchObject({ userId: "u-tech", timeIn: "", signature: null });
  });

  it("does not list a carried name twice", () => {
    const previous = sheet([
      row("x", { userId: "u-tech", employee: "Dana Smith" }),
      row("y", { employee: "josé peña" }),
    ]);
    const p = prefillSignIn({ job: JOB, day: "2026-10-07", spans, crew, previous, newId: ids });
    expect(p.rows.filter((r) => r.userId === "u-tech")).toHaveLength(1);
    expect(p.rows.filter((r) => r.employee.toLowerCase() === "josé peña")).toHaveLength(1);
  });

  it("starts empty-handed but still headed when nobody is on the job yet", () => {
    const p = prefillSignIn({
      job: JOB,
      day: "2026-10-07",
      spans: [],
      crew: [],
      previous: null,
      newId: ids,
    });
    expect(p.rows).toEqual([]);
    expect(p.jobName).toBe("Marriott Riverside");
  });
});

describe("sign-in sheet: two phones, one sheet", () => {
  it("keeps rows signed on the other phone", () => {
    const stored = sheet([row("a", { signature: "data:image/png;base64,AAA" }), row("b")]);
    const local = sheet([row("a"), row("c")]);
    const merged = mergeSignIn(stored, local);
    expect(merged.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("lets this phone's copy of a row win", () => {
    const stored = sheet([row("a", { timeOut: "" })]);
    const local = sheet([row("a", { timeOut: "16:00" })]);
    expect(mergeSignIn(stored, local).rows[0]!.timeOut).toBe("16:00");
  });

  it("does not bring back a row this phone removed", () => {
    const stored = sheet([row("a"), row("b")]);
    const local = sheet([row("a")], ["b"]);
    const merged = mergeSignIn(stored, local);
    expect(merged.rows.map((r) => r.id)).toEqual(["a"]);
    expect(merged.removed).toEqual(["b"]);
  });

  it("with nothing stored, is just this phone's sheet", () => {
    const local = sheet([row("a")]);
    expect(mergeSignIn(null, local)).toBe(local);
  });

  it("drops the blank rows Add person leaves behind", () => {
    const p = sheet([row("a", { employee: "" }), row("b", { employee: "Dana" })]);
    expect(trimSignIn(p).rows.map((r) => r.id)).toEqual(["b"]);
  });
});

describe("supply list", () => {
  it("keeps only lines with a quantity, one per code", () => {
    expect(
      keepQuantities([
        { code: "GL", qty: 2 },
        { code: "103", qty: 0 },
        { code: "302", qty: -1 },
        { code: "311", qty: Number.NaN },
        { code: "GL", qty: 3 },
        { code: " ", qty: 4 },
        { code: "150", qty: 2.499 },
      ]),
    ).toEqual([
      { code: "GL", qty: 3 },
      { code: "150", qty: 2.5 },
    ]);
  });

  it("sorts lines into the paper's order", () => {
    expect(
      sortByCatalogue(
        [
          { code: "400", qty: 1 },
          { code: "APM", qty: 1 },
          { code: "100", qty: 1 },
        ],
        TM_RATE_CODES_COMPILED,
      ).map((l) => l.code),
    ).toEqual(["APM", "100", "400"]);
  });

  it("a new day starts with the header and the crew count, no quantities", () => {
    expect(prefillSupplyList({ job: JOB, crewCount: 5, previous: null })).toEqual({
      jobName: "Marriott Riverside",
      jobLocation: "100 River Rd, Newark, NJ 07102",
      totalCrew: "5",
      lines: [],
    });
  });
});

describe("crew chief report", () => {
  it("a new day: the job's crew chief, the site crew as staff, yesterday's zone", () => {
    const p = prefillCrewChief({
      job: JOB,
      crewChiefName: "José Peña",
      crew: [
        { userId: "1", name: "José Peña", role: "crew_chief" },
        { userId: "2", name: "Dana Smith", role: "technician" },
        { userId: "3", name: "Rae Sales", role: "account_rep" },
      ],
      previous: normaliseCrewChief({ supervisor: "Heshy", workZone: "Floor 3", crewNumber: "2" }),
    });
    expect(p.crewChief).toBe("José Peña");
    expect(p.staff.filter(Boolean)).toEqual(["Dana Smith"]);
    expect(p.staff).toHaveLength(CREW_STAFF_SLOTS);
    expect(p.crewSize).toBe("2");
    expect(p).toMatchObject({
      supervisor: "Heshy",
      workZone: "Floor 3",
      crewNumber: "2",
      notes: "",
    });
  });
});

describe("reading stored sheets defensively", () => {
  it("survives junk without throwing", () => {
    expect(normaliseSignIn(null).rows).toEqual([]);
    expect(
      normaliseSignIn({ rows: [{ timeIn: "7am", lodging: "yacht", signature: "x" }] }).rows[0],
    ).toMatchObject({ timeIn: "", lodging: "", signature: null });
    expect(normaliseCrewChief("nope").staff).toHaveLength(CREW_STAFF_SLOTS);
    expect(
      normaliseSupplyList({ lines: [{ code: "GL", qty: "2" }, { code: "PM" }] }).lines,
    ).toEqual([{ code: "GL", qty: 2 }]);
  });
});

describe("reopening a day", () => {
  const item = (payload: Record<string, unknown>, createdAt: number) => ({
    kind: "tm_field_form",
    payload,
    createdAt,
  });
  const write = (kind: string, day: string, p: unknown) => ({
    job_id: "job-1",
    kind,
    form_date: day,
    payload: p,
  });

  it("opens the newest save still held on this phone for that sheet and day", () => {
    const items = [
      item(write("sign_in", "2026-10-07", sheet([row("old")])), 1),
      item(write("sign_in", "2026-10-07", sheet([row("new")])), 2),
      item(write("sign_in", "2026-10-06", sheet([row("yesterday")])), 3),
      item(write("supply_list", "2026-10-07", { lines: [] }), 4),
    ];
    expect(heldPayload(items, "job-1", "sign_in", "2026-10-07")!.rows[0]!.id).toBe("new");
    expect(heldPayload(items, "job-1", "sign_in", "2026-10-08")).toBeNull();
    expect(heldPayload(items, "job-2", "sign_in", "2026-10-07")).toBeNull();
  });

  it("names files by sheet, job and day", () => {
    expect(tmFormFilename("sign_in", "2026-10-07", "GS-1042")).toBe(
      "crew-sign-in-sheet-GS-1042-2026-10-07.pdf",
    );
    expect(tmFormFilename("supply_list", null)).toBe("daily-supply-list-blank.pdf");
  });
});

describe("the write", () => {
  /** A stand-in for the PostgREST client: records the upsert, answers the read. */
  function client(stored: unknown) {
    const calls: { upsert?: unknown; onConflict?: string } = {};
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: stored ? { payload: stored } : null, error: null }),
      upsert: async (row: unknown, opts: { onConflict: string }) => {
        calls.upsert = row;
        calls.onConflict = opts.onConflict;
        return { error: null };
      },
    };
    return { calls, c: { from: () => chain } as never };
  }
  const base = (kind: TmFormWrite["kind"], payload: unknown): TmFormWrite => ({
    id: "new-id",
    job_id: "job-1",
    kind,
    form_date: "2026-10-07",
    payload: payload as Record<string, unknown>,
    captured_at: "2026-10-07T20:00:00Z",
    created_by: "u1",
  });

  it("is keyed on job, kind and day — so the same day reopens the same sheet", async () => {
    const { calls, c } = client(null);
    await writeTmForm(base("crew_chief", { notes: "x" }), c);
    expect(calls.onConflict).toBe("job_id,kind,form_date");
  });

  it("merges a sign-in sheet with what is stored before writing", async () => {
    const { calls, c } = client(sheet([row("other-phone")]));
    await writeTmForm(base("sign_in", sheet([row("mine")])), c);
    const written = calls.upsert as { payload: SignInPayload };
    expect(written.payload.rows.map((r) => r.id)).toEqual(["other-phone", "mine"]);
  });
});

/*
 * David, 12 Oct: the supply list renews every day — a fresh sheet each
 * morning — while earlier days stay openable and editable; and the hotel /
 * per diem box is a plain yes / blank toggle.
 */
describe("sheetDay — the panel follows the calendar", () => {
  it("is today when nobody picked a day", () => {
    expect(sheetDay(null, "2026-10-13")).toBe("2026-10-13");
  });

  it("rolls over by itself: a phone left open overnight shows the new day", () => {
    const chosen = null;
    expect(sheetDay(chosen, "2026-10-12")).toBe("2026-10-12");
    expect(sheetDay(chosen, "2026-10-13")).toBe("2026-10-13");
  });

  it("stays on an earlier day somebody opened, so it can be edited", () => {
    expect(sheetDay("2026-10-09", "2026-10-13")).toBe("2026-10-09");
  });

  it("a fresh day's supply list starts empty, not as a copy of yesterday's", () => {
    const yesterday = {
      jobName: "Smith",
      jobLocation: "12 Main St",
      totalCrew: "4",
      lines: [{ code: "TYVEK", qty: 6 }],
    };
    expect(prefillSupplyList({ job: JOB, crewCount: 4, previous: yesterday }).lines).toEqual([]);
  });
});

describe("hotel / per diem — a yes or blank toggle", () => {
  const signIn = (lodging: string) =>
    normaliseSignIn({ rows: [{ id: "r1", employee: "Juan Perez", lodging }] }).rows[0]!.lodging;

  it("stores yes, and blank for no", () => {
    expect(signIn("yes")).toBe("yes");
    expect(signIn("")).toBe("");
  });

  it("still reads the sheets saved before the toggle", () => {
    expect(signIn("hotel_per_diem")).toBe("hotel_per_diem");
    expect(signIn("per_diem")).toBe("per_diem");
  });
});
