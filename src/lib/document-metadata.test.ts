import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UNKNOWN_PERSON,
  buildPersonNames,
  metadataLine,
  normalizeStamp,
  personName,
  uploadedStamp,
} from "./document-metadata";

const DAVID = "1f37c3ff-c589-4c5c-8960-31e55e110368";
const NAMES = buildPersonNames([
  // The live row carries a trailing space; personLabel trims it.
  { user_id: DAVID, full_name: "David Stern " },
  { user_id: "nameless", full_name: null },
]);

describe("buildPersonNames", () => {
  it("indexes by user id and trims the stored name", () => {
    expect(NAMES.get(DAVID)).toBe("David Stern");
  });

  it("falls back to the app-wide label for a profile that was never named", () => {
    expect(NAMES.get("nameless")).toBe("Removed user");
  });

  it("survives a null answer and skips rows with no id", () => {
    expect(buildPersonNames(null).size).toBe(0);
    expect(buildPersonNames([{ user_id: "", full_name: "Ghost" }]).size).toBe(0);
  });
});

describe("personName", () => {
  it("resolves a known uploader", () => {
    expect(personName(DAVID, NAMES)).toBe("David Stern");
  });

  it('says "Unknown" when nothing recorded who filed it', () => {
    expect(personName(null, NAMES)).toBe(UNKNOWN_PERSON);
    expect(personName(undefined, NAMES)).toBe(UNKNOWN_PERSON);
  });

  it('says "Unknown" — never "null" or blank — for an id it cannot resolve', () => {
    // RLS narrows profiles to the viewer's offices, so an unresolved id is
    // more often hidden than deleted. Do not claim the person was removed.
    const label = personName("someone-outside-my-offices", NAMES);
    expect(label).toBe(UNKNOWN_PERSON);
    expect(label).not.toBe("");
    expect(label).not.toMatch(/null|undefined|Removed/i);
  });
});

describe("normalizeStamp", () => {
  it("anchors a date-only value at noon so it never renders a day early", () => {
    // The merge-keys bug: new Date("2026-09-01") is UTC midnight, which is
    // 31 August in every US office.
    expect(normalizeStamp("2026-09-01")).toBe("2026-09-01T12:00:00");
    expect(new Date(normalizeStamp("2026-09-01")!).getDate()).toBe(1);
  });

  it("leaves a full timestamp alone", () => {
    const iso = "2026-08-25T15:44:50.284880+00:00";
    expect(normalizeStamp(iso)).toBe(iso);
  });

  it("returns null for empty and unparseable input rather than Invalid Date", () => {
    expect(normalizeStamp(null)).toBeNull();
    expect(normalizeStamp(undefined)).toBeNull();
    expect(normalizeStamp("   ")).toBeNull();
    expect(normalizeStamp("not a date")).toBeNull();
  });
});

describe("uploadedStamp and metadataLine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pairs a relative label with an exact timestamp for the tooltip", () => {
    const stamp = uploadedStamp("2026-08-25T15:44:50+00:00");
    expect(stamp?.relative).toBe("12 days ago");
    expect(stamp?.exact).toMatch(/Aug 25, 2026/);
  });

  it("builds the row text and the hover title for a document", () => {
    const line = metadataLine("2026-08-25T15:44:50+00:00", DAVID, NAMES);
    expect(line?.text).toBe("12 days ago · David Stern");
    expect(line?.title).toMatch(/^Uploaded Aug 25, 2026.* by David Stern$/);
  });

  it("shows Unknown rather than a blank when the row has no uploader", () => {
    const line = metadataLine("2026-09-07T09:00:00+00:00", null, NAMES);
    expect(line?.text).toBe("today · Unknown");
    expect(line?.title).toMatch(/by Unknown$/);
  });

  it("drops the person entirely when the column itself is missing", () => {
    // Not the same as a row without a value: the database was never asked,
    // so a list of "Unknown" would overstate what we know.
    const line = metadataLine("2026-08-25T15:44:50+00:00", null, NAMES, {
      uploaderKnown: false,
    });
    expect(line?.text).toBe("12 days ago");
    expect(line?.title).not.toMatch(/by/);
  });

  it("relabels the verb for a signature request", () => {
    const line = metadataLine("2026-08-25T15:44:50+00:00", DAVID, NAMES, { verb: "Requested" });
    expect(line?.text).toBe("12 days ago · David Stern");
    expect(line?.title).toMatch(/^Requested /);
  });

  it("returns null when there is neither a date nor a person to show", () => {
    expect(metadataLine(null, null, NAMES, { uploaderKnown: false })).toBeNull();
  });

  it("still names the person when the timestamp is unusable", () => {
    const line = metadataLine("not a date", DAVID, NAMES);
    expect(line?.text).toBe("David Stern");
    expect(line?.title).toBe("Uploaded by David Stern");
  });
});
