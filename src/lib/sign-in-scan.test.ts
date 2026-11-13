import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  SCAN_MAX_ROWS,
  applyScan,
  laterThan,
  matchPerson,
  nameKey,
  parseSignInModelOutput,
  toHHMM,
} from "./sign-in-scan";
import { readSignInSheetInput } from "./sign-in-scan.functions";
import type { SignInPayload } from "./tm-forms";

/* 11 Nov: scanning the paper Crew Sign In/Out Sheet (the Berkshire sample). */
describe("reading times off the paper", () => {
  it("takes the ways a crew writes a time", () => {
    expect(toHHMM("9:00")).toBe("09:00");
    expect(toHHMM("9:8")).toBe("09:08");
    expect(toHHMM("10:25")).toBe("10:25");
    expect(toHHMM("930")).toBe("09:30");
    expect(toHHMM("5pm")).toBe("17:00");
    expect(toHHMM("5:20 PM")).toBe("17:20");
    expect(toHHMM("17:20")).toBe("17:20");
    expect(toHHMM("")).toBe("");
    expect(toHHMM("4oo")).toBe("");
    expect(toHHMM("25:00")).toBe("");
  });

  it("puts a time out written smaller than the start in the afternoon", () => {
    expect(laterThan("09:00", "05:20")).toBe("17:20");
    expect(laterThan("09:00", "03:11")).toBe("15:11");
    expect(laterThan("09:00", "17:20")).toBe("17:20");
    expect(laterThan("", "05:20")).toBe("05:20");
  });
});

describe("the model's reply", () => {
  it("becomes rows: names as written, codes upper-case, a 5:20 out after 9:30 in is 17:20", () => {
    const sheet = parseSignInModelOutput(
      JSON.stringify({
        job_name: "Berkshire at Towne Center",
        job_location: "204 E Jappa Road Towson MD 21286",
        date: "2026-11-09",
        rows: [
          {
            employee: "Jimenez, Tatiana",
            rate_code: "dl",
            time_in: "9:30",
            time_out: "5:20",
            lodging: false,
            signed: true,
          },
          {
            employee: "Pedro, Jefri",
            rate_code: "CCF",
            time_in: "9:8",
            time_out: "3:11",
            signed: true,
          },
          { employee: "", rate_code: "DL", time_in: "9:00" },
        ],
      }),
    )!;
    expect(sheet.jobName).toBe("Berkshire at Towne Center");
    expect(sheet.date).toBe("2026-11-09");
    expect(sheet.rows).toEqual([
      {
        employee: "Jimenez, Tatiana",
        rateCode: "DL",
        timeIn: "09:30",
        lunchStart: "",
        lunchEnd: "",
        timeOut: "17:20",
        lodging: false,
        signed: true,
      },
      {
        employee: "Pedro, Jefri",
        rateCode: "CCF",
        timeIn: "09:08",
        lunchStart: "",
        lunchEnd: "",
        timeOut: "15:11",
        lodging: false,
        signed: true,
      },
    ]);
  });

  it("treats the reply as data: bad dates dropped, text trimmed, rows capped", () => {
    const sheet = parseSignInModelOutput(
      JSON.stringify({
        date: "11/09/26",
        rows: Array.from({ length: 120 }, (_, i) => ({
          employee: `Person ${i}\u0000`,
          rate_code: "D L!",
        })),
      }),
    )!;
    expect(sheet.date).toBeNull();
    expect(sheet.rows).toHaveLength(SCAN_MAX_ROWS);
    expect(sheet.rows[0]).toMatchObject({ employee: "Person 0", rateCode: "DL" });
    expect(parseSignInModelOutput("Sorry, I can't read that.")).toBeNull();
  });
});

describe("names", () => {
  it("matches a name written either way round, ignoring case and accents", () => {
    expect(nameKey("Gutierrez, Rose")).toBe(nameKey("rose GUTIERREZ"));
    expect(nameKey("Pérez, Glendy")).toBe(nameKey("Glendy Perez"));
    const people = [
      { userId: "u1", name: "Rose Gutierrez" },
      { userId: null, name: "Yanireth Gutierrez" },
    ];
    expect(matchPerson("Gutierrez, Rose", people)?.userId).toBe("u1");
    expect(matchPerson("Gutierrez, Ana", people)).toBeNull();
  });
});

describe("onto the day's sheet", () => {
  const sheet: SignInPayload = {
    jobName: "Berkshire",
    jobLocation: "Towson",
    removed: [],
    rows: [
      {
        id: "r1",
        userId: "u1",
        employee: "Rose Gutierrez",
        rateCode: "DL",
        timeIn: "08:55",
        lunchStart: "",
        lunchEnd: "",
        timeOut: "",
        lodging: "",
        signature: "data:image/png;base64,AAAA",
        signedAt: "2026-11-09T13:55:00Z",
      },
    ],
  };
  const scanned = [
    {
      employee: "Gutierrez, Rose",
      rateCode: "DL",
      timeIn: "09:00",
      lunchStart: "",
      lunchEnd: "",
      timeOut: "17:00",
      lodging: false,
      signed: true,
    },
    {
      employee: "Williams, Herlington",
      rateCode: "CCF",
      timeIn: "09:00",
      lunchStart: "",
      lunchEnd: "",
      timeOut: "",
      lodging: true,
      signed: true,
    },
    {
      employee: "Woo, Alicia",
      rateCode: "ZZ",
      timeIn: "09:00",
      lunchStart: "",
      lunchEnd: "",
      timeOut: "",
      lodging: false,
      signed: true,
    },
  ];
  let n = 0;
  const res = applyScan(sheet, scanned, {
    newId: () => `new-${++n}`,
    people: [{ userId: "u9", name: "Herlington Williams" }],
    codes: new Set(["DL", "CCF"]),
  });

  it("keeps what a crew member entered on a phone and fills only the empty boxes", () => {
    const rose = res.sheet.rows[0]!;
    expect(rose.timeIn).toBe("08:55");
    expect(rose.timeOut).toBe("17:00");
    expect(rose.signature).toBe("data:image/png;base64,AAAA");
    expect(res.updated).toBe(1);
  });

  it("adds everyone else, linked to their login when the crew list knows them", () => {
    expect(res.added).toBe(2);
    expect(res.sheet.rows[1]).toMatchObject({
      id: "new-1",
      userId: "u9",
      employee: "Herlington Williams",
      rateCode: "CCF",
      lodging: "yes",
      signature: null,
    });
  });

  it("leaves a rate code the catalogue does not know for a person to pick", () => {
    expect(res.sheet.rows[2]).toMatchObject({
      employee: "Woo, Alicia",
      rateCode: "",
      userId: null,
    });
  });
});

describe("what the server refuses before the model is called", () => {
  it("takes one image data URL and nothing else", () => {
    expect(
      readSignInSheetInput.safeParse({
        image_data_url: `data:image/jpeg;base64,${"A".repeat(100)}`,
      }).success,
    ).toBe(true);
    expect(
      readSignInSheetInput.safeParse({
        image_data_url: `data:application/pdf;base64,${"A".repeat(100)}`,
      }).success,
    ).toBe(false);
  });
});
