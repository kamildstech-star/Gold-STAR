import { describe, expect, it } from "vitest";

import {
  federalHolidayName,
  federalHolidays,
  hebrewDateOf,
  isWeekend,
  isWorkingDay,
  jewishHolidayName,
  nonWorkingReason,
  previousWorkingDay,
  shiftDateKey,
  todayKey,
  weekdayOf,
  workingDaysBack,
} from "./working-days";

/* --------------------------------------------------------- date helpers */

describe("date keys", () => {
  it("shifts across a month, a year and a leap day without touching local time", () => {
    expect(shiftDateKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDateKey("2028-03-01", -1)).toBe("2028-02-29");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    // The two DST changes of 2026 are ordinary 24-hour steps in key space.
    expect(shiftDateKey("2026-03-08", 1)).toBe("2026-03-09");
    expect(shiftDateKey("2026-11-01", 1)).toBe("2026-11-02");
  });

  it("knows the weekday", () => {
    expect(weekdayOf("2026-09-12")).toBe(6); // Saturday
    expect(weekdayOf("2026-09-13")).toBe(0); // Sunday
    expect(weekdayOf("2026-09-14")).toBe(1); // Monday
  });

  it("today is the New York date, not the UTC one", () => {
    // 11pm Tuesday in New York (EDT) is 3am Wednesday UTC.
    expect(todayKey(Date.parse("2026-09-09T03:00:00Z"))).toBe("2026-09-08");
    expect(todayKey(Date.parse("2026-09-09T05:00:00Z"))).toBe("2026-09-09");
    // Same in winter (EST): 11:30pm Monday Dec 21 is 4:30am Tuesday UTC.
    expect(todayKey(Date.parse("2026-12-22T04:30:00Z"))).toBe("2026-12-21");
  });
});

/* -------------------------------------------------------------- weekends */

describe("weekends", () => {
  it("Saturday and Sunday are not working days; Friday and Monday are", () => {
    expect(isWeekend("2026-09-11")).toBe(false);
    expect(isWeekend("2026-09-12")).toBe(true);
    expect(isWeekend("2026-09-13")).toBe(true);
    expect(isWeekend("2026-09-14")).toBe(false);
    expect(nonWorkingReason("2026-09-19")).toBe("Saturday");
    expect(nonWorkingReason("2026-09-20")).toBe("Sunday");
  });
});

/* ------------------------------------------------------ federal holidays */

const FEDERAL_2026: [string, string][] = [
  ["2026-01-01", "New Year's Day"],
  ["2026-01-19", "Martin Luther King Jr. Day"],
  ["2026-02-16", "Presidents' Day"],
  ["2026-05-25", "Memorial Day"],
  ["2026-06-19", "Juneteenth"],
  ["2026-07-03", "Independence Day"], // Jul 4 2026 is a Saturday → observed Friday
  ["2026-09-07", "Labor Day"],
  ["2026-10-12", "Columbus Day"],
  ["2026-11-11", "Veterans Day"],
  ["2026-11-26", "Thanksgiving"],
  ["2026-12-25", "Christmas Day"],
];

const FEDERAL_2027: [string, string][] = [
  ["2027-01-01", "New Year's Day"],
  ["2027-01-18", "Martin Luther King Jr. Day"],
  ["2027-02-15", "Presidents' Day"],
  ["2027-05-31", "Memorial Day"],
  ["2027-06-18", "Juneteenth"], // Jun 19 2027 is a Saturday → observed Friday
  ["2027-07-05", "Independence Day"], // Jul 4 2027 is a Sunday → observed Monday
  ["2027-09-06", "Labor Day"],
  ["2027-10-11", "Columbus Day"],
  ["2027-11-11", "Veterans Day"],
  ["2027-11-25", "Thanksgiving"],
  ["2027-12-24", "Christmas Day"], // Dec 25 2027 is a Saturday → observed Friday
  ["2027-12-31", "New Year's Day"], // Jan 1 2028 is a Saturday → observed Dec 31 2027
];

describe("federal holidays", () => {
  it("2026 — the full observed set and nothing else", () => {
    expect([...federalHolidays(2026).entries()].sort()).toEqual([...FEDERAL_2026].sort());
  });

  it("2027 — including three observed-day shifts and next year's New Year's Day", () => {
    expect([...federalHolidays(2027).entries()].sort()).toEqual([...FEDERAL_2027].sort());
  });

  it("the nominal date of a shifted holiday is an ordinary day off only because it is a weekend", () => {
    expect(federalHolidayName("2026-07-04")).toBeNull();
    expect(nonWorkingReason("2026-07-04")).toBe("Saturday");
    expect(nonWorkingReason("2026-07-03")).toBe("Independence Day");
    expect(nonWorkingReason("2027-12-24")).toBe("Christmas Day");
    expect(nonWorkingReason("2027-12-27")).toBeNull();
  });
});

/* ------------------------------------------------------ jewish holidays */

/** Yom tov (diaspora), as hebcal computes them — the office is closed on every one. */
const YOM_TOV_5786_TO_5789: [string, string][] = [
  // 5786 (spring 2026)
  ["2026-04-02", "Pesach I"],
  ["2026-04-03", "Pesach II"],
  ["2026-04-08", "Pesach VII"],
  ["2026-04-09", "Pesach VIII"],
  ["2026-05-22", "Shavuot I"],
  ["2026-05-23", "Shavuot II"],
  // 5787
  ["2026-09-12", "Rosh Hashanah"],
  ["2026-09-13", "Rosh Hashanah II"],
  ["2026-09-21", "Yom Kippur"],
  ["2026-09-26", "Sukkot I"],
  ["2026-09-27", "Sukkot II"],
  ["2026-10-03", "Shemini Atzeret"],
  ["2026-10-04", "Simchat Torah"],
  ["2027-04-22", "Pesach I"],
  ["2027-04-23", "Pesach II"],
  ["2027-04-28", "Pesach VII"],
  ["2027-04-29", "Pesach VIII"],
  ["2027-06-11", "Shavuot I"],
  ["2027-06-12", "Shavuot II"],
  // 5788
  ["2027-10-02", "Rosh Hashanah"],
  ["2027-10-03", "Rosh Hashanah II"],
  ["2027-10-11", "Yom Kippur"],
  ["2027-10-16", "Sukkot I"],
  ["2027-10-17", "Sukkot II"],
  ["2027-10-23", "Shemini Atzeret"],
  ["2027-10-24", "Simchat Torah"],
  ["2028-04-11", "Pesach I"],
  ["2028-04-12", "Pesach II"],
  ["2028-04-17", "Pesach VII"],
  ["2028-04-18", "Pesach VIII"],
  ["2028-05-31", "Shavuot I"],
  ["2028-06-01", "Shavuot II"],
  // 5789
  ["2028-09-21", "Rosh Hashanah"],
  ["2028-09-22", "Rosh Hashanah II"],
  ["2028-09-30", "Yom Kippur"],
  ["2028-10-05", "Sukkot I"],
  ["2028-10-06", "Sukkot II"],
  ["2028-10-12", "Shemini Atzeret"],
  ["2028-10-13", "Simchat Torah"],
];

function everyDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = from; k <= to; k = shiftDateKey(k, 1)) out.push(k);
  return out;
}

describe("jewish holidays (diaspora yom tov)", () => {
  it("the engine has a Hebrew calendar and reads 1 Tishri 5787 on Sep 12 2026", () => {
    expect(hebrewDateOf("2026-09-12")).toEqual({ year: 5787, month: "tishri", day: 1 });
    expect(hebrewDateOf("2026-04-02")).toEqual({ year: 5786, month: "nisan", day: 15 });
    // 5787 is a leap year: Adar I and Adar II.
    expect(hebrewDateOf("2027-03-13")?.month).toBe("adar-ii");
    expect(hebrewDateOf("2026-03-03")?.month).toBe("adar");
  });

  it("matches hebcal on every day of 2026–2028: exactly the yom tov dates, no others", () => {
    const expected = new Map(YOM_TOV_5786_TO_5789);
    for (const day of everyDay("2026-01-01", "2028-12-31")) {
      expect([day, jewishHolidayName(day)]).toEqual([day, expected.get(day) ?? null]);
    }
  });

  it("fast days, chol hamoed, Chanukah and Purim are not closures unless asked for", () => {
    expect(jewishHolidayName("2026-09-14")).toBeNull(); // Tzom Gedaliah
    expect(jewishHolidayName("2026-09-28")).toBeNull(); // Chol Hamoed Sukkot
    expect(jewishHolidayName("2026-12-05")).toBeNull(); // Chanukah day 1
    expect(jewishHolidayName("2027-03-23")).toBeNull(); // Purim
    expect(isWorkingDay("2027-03-23")).toBe(true);
  });

  it("the optional groups match hebcal when switched on", () => {
    // Chol hamoed, diaspora: Sukkot III–VII (Hoshana Rabbah), Pesach III–VI.
    for (const d of everyDay("2026-09-28", "2026-10-02")) {
      expect(jewishHolidayName(d, ["cholHamoed"])).toBe("Chol Hamoed Sukkot");
    }
    for (const d of everyDay("2026-04-04", "2026-04-07")) {
      expect(jewishHolidayName(d, ["cholHamoed"])).toBe("Chol Hamoed Pesach");
    }
    expect(jewishHolidayName("2026-04-08", ["cholHamoed"])).toBe("Pesach VII");

    // Chanukah: eight days from 25 Kislev. hebcal's "1 Candle" is the evening
    // before, which is not a day of Chanukah.
    expect(jewishHolidayName("2026-12-04", ["chanukah"])).toBeNull();
    for (const d of everyDay("2026-12-05", "2026-12-12")) {
      expect(jewishHolidayName(d, ["chanukah"])).toBe("Chanukah");
    }
    expect(jewishHolidayName("2026-12-13", ["chanukah"])).toBeNull();
    for (const d of everyDay("2027-12-25", "2028-01-01")) {
      expect(jewishHolidayName(d, ["chanukah"])).toBe("Chanukah");
    }

    // Purim: Adar 14 in a common year, Adar II 14 in a leap year.
    expect(jewishHolidayName("2026-03-03", ["purim"])).toBe("Purim");
    expect(jewishHolidayName("2027-03-23", ["purim"])).toBe("Purim");
    expect(jewishHolidayName("2028-03-12", ["purim"])).toBe("Purim");
    expect(jewishHolidayName("2027-02-21", ["purim"])).toBeNull(); // Purim Katan (Adar I)

    // Fast days, including the Shabbat postponements hebcal applies.
    const fasts: [string, string][] = [
      ["2026-03-02", "Ta'anit Esther"],
      ["2026-07-02", "Shiva Asar B'Tammuz"],
      ["2026-07-23", "Tisha B'Av"],
      ["2026-09-14", "Tzom Gedaliah"],
      ["2026-12-20", "Asara B'Tevet"],
      ["2027-03-22", "Ta'anit Esther"],
      ["2027-07-22", "Shiva Asar B'Tammuz"],
      ["2027-08-12", "Tisha B'Av"],
      ["2027-10-04", "Tzom Gedaliah"],
      ["2028-01-09", "Asara B'Tevet"],
      ["2028-03-09", "Ta'anit Esther"], // 13 Adar 5788 is a Saturday → Thursday 11 Adar
      ["2028-07-11", "Shiva Asar B'Tammuz"],
      ["2028-08-01", "Tisha B'Av"],
      ["2028-09-24", "Tzom Gedaliah"], // 3 Tishri 5789 is a Saturday → Sunday
      ["2028-12-28", "Asara B'Tevet"],
    ];
    const expected = new Map(fasts);
    for (const day of everyDay("2026-01-01", "2028-12-31")) {
      const got = jewishHolidayName(day, ["fastDays"]);
      const want = expected.get(day) ?? new Map(YOM_TOV_5786_TO_5789).get(day) ?? null;
      expect([day, got]).toEqual([day, want]);
    }
  });
});

/* ---------------------------------------------------------- working days */

describe("isWorkingDay / previousWorkingDay / workingDaysBack", () => {
  it("skips a weekend, a yom tov and a federal holiday in one walk", () => {
    // Back from Tuesday Sep 22 2026: Mon 21 is Yom Kippur, 19–20 the weekend.
    expect(previousWorkingDay("2026-09-22")).toBe("2026-09-18");
    // Back from Tuesday Sep 8 2026: Mon 7 is Labor Day.
    expect(previousWorkingDay("2026-09-08")).toBe("2026-09-04");
    // Back from Rosh Hashanah week: Fri 11 → Mon 14 (RH is Sat–Sun 12–13, so
    // nothing is lost to the holiday that year), and Mon 14 → Fri 11.
    expect(previousWorkingDay("2026-09-14")).toBe("2026-09-11");
  });

  it("walks working days newest first, starting at the given day only if it is one", () => {
    expect([...workingDaysBack("2026-09-22", 4)]).toEqual([
      "2026-09-22",
      "2026-09-18",
      "2026-09-17",
      "2026-09-16",
    ]);
    // Starting on a Saturday begins at the Friday before.
    expect([...workingDaysBack("2026-09-12", 2)]).toEqual(["2026-09-11", "2026-09-10"]);
  });

  it("a company closure is a day off and says so", () => {
    const closures = new Set(["2026-09-16"]);
    expect(isWorkingDay("2026-09-16")).toBe(true);
    expect(isWorkingDay("2026-09-16", { closures })).toBe(false);
    expect(nonWorkingReason("2026-09-16", { closures })).toBe("Company closure");
    expect(previousWorkingDay("2026-09-17", { closures })).toBe("2026-09-15");
  });

  it("optional Jewish groups close the office when configured", () => {
    expect(isWorkingDay("2026-12-07")).toBe(true);
    expect(isWorkingDay("2026-12-07", { jewishGroups: ["chanukah"] })).toBe(false);
  });
});
