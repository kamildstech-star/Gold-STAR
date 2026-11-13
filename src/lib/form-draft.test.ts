import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAFT_MAX_AGE_MS,
  DRAFT_SHAPE_VERSION,
  draftAge,
  draftHasContent,
  draftKey,
  isRestorableDraft,
  makeDraftSaver,
  sanitizeDraftValues,
} from "./form-draft";

/*
 * Every clock in here is handed in. A fixture date plus a function that
 * reaches for Date.now() itself is what took main red on 24 September — the
 * fixture aged with the calendar until it crossed a threshold. `now` is a
 * required argument throughout form-draft.ts so that cannot be written.
 */
const NOW = Date.UTC(2026, 9, 5, 14, 0, 0);
const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const draft = (over: Record<string, unknown> = {}) => ({
  ownerId: OWNER,
  formId: "job-new",
  version: DRAFT_SHAPE_VERSION,
  savedAt: NOW - 60_000,
  values: { address: "123 Elm Street" },
  ...over,
});

describe("draftKey", () => {
  it("carries owner and form, both encoded", () => {
    expect(draftKey(OWNER, "job-new")).toBe(`form-draft:${OWNER}:job-new`);
  });

  it("cannot be forged by an owner id containing the separator", () => {
    const a = draftKey("a:job-new", "x");
    const b = draftKey("a", "job-new:x");
    expect(a).not.toBe(b);
    expect(a).toBe("form-draft:a%3Ajob-new:x");
  });
});

describe("isRestorableDraft", () => {
  it("accepts this user's own fresh draft for this form", () => {
    expect(isRestorableDraft(draft(), { ownerId: OWNER, formId: "job-new", now: NOW })).toBe(true);
  });

  it("refuses another user's draft — shared field tablet", () => {
    expect(
      isRestorableDraft(draft({ ownerId: OTHER }), { ownerId: OWNER, formId: "job-new", now: NOW }),
    ).toBe(false);
  });

  it("refuses a draft saved for a different form", () => {
    expect(
      isRestorableDraft(draft({ formId: "estimate-new" }), {
        ownerId: OWNER,
        formId: "job-new",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("refuses a draft written by an incompatible build", () => {
    expect(
      isRestorableDraft(draft({ version: DRAFT_SHAPE_VERSION + 1 }), {
        ownerId: OWNER,
        formId: "job-new",
        now: NOW,
      }),
    ).toBe(false);
  });

  it("refuses a draft older than the retention window, and keeps the last fresh minute", () => {
    const stale = draft({ savedAt: NOW - DRAFT_MAX_AGE_MS - 1 });
    const edge = draft({ savedAt: NOW - DRAFT_MAX_AGE_MS });
    const opts = { ownerId: OWNER, formId: "job-new", now: NOW };
    expect(isRestorableDraft(stale, opts)).toBe(false);
    expect(isRestorableDraft(edge, opts)).toBe(true);
  });

  it("tolerates a clock that moved backwards", () => {
    expect(
      isRestorableDraft(draft({ savedAt: NOW + 60_000 }), {
        ownerId: OWNER,
        formId: "job-new",
        now: NOW,
      }),
    ).toBe(true);
  });

  it("refuses anything that is not a draft record", () => {
    const opts = { ownerId: OWNER, formId: "job-new", now: NOW };
    expect(isRestorableDraft(undefined, opts)).toBe(false);
    expect(isRestorableDraft(null, opts)).toBe(false);
    expect(isRestorableDraft("job-new", opts)).toBe(false);
    expect(isRestorableDraft([draft()], opts)).toBe(false);
    expect(isRestorableDraft(draft({ values: null }), opts)).toBe(false);
    expect(isRestorableDraft(draft({ savedAt: "yesterday" }), opts)).toBe(false);
  });
});

describe("sanitizeDraftValues", () => {
  it("keeps the shapes a form actually holds", () => {
    const { values, dropped } = sanitizeDraftValues({
      address: "123 Elm Street",
      deductible: 1000,
      addlWork: false,
      typedJobName: null,
      methods: [{ kind: "phone", value: "555-0100" }],
      account: { id: "a1", name: "Acme", primary_contact: { full_name: "Dana" } },
    });
    expect(dropped).toEqual([]);
    expect(values).toEqual({
      address: "123 Elm Street",
      deductible: 1000,
      addlWork: false,
      typedJobName: null,
      methods: [{ kind: "phone", value: "555-0100" }],
      account: { id: "a1", name: "Acme", primary_contact: { full_name: "Dana" } },
    });
  });

  it("drops a File rather than failing the whole save, and says where it was", () => {
    const file = new File(["x"], "roof.jpg", { type: "image/jpeg" });
    const { values, dropped } = sanitizeDraftValues({
      address: "123 Elm Street",
      photos: [file],
      cover: file,
    });
    expect(dropped).toEqual(["photos[0]", "cover"]);
    // The array keeps its length so an index-addressed field does not shift.
    expect(values).toEqual({ address: "123 Elm Street", photos: [null] });
  });

  it("drops functions and class instances", () => {
    class Picked {
      id = "p1";
    }
    const { values, dropped } = sanitizeDraftValues({
      onSelect: () => {},
      when: new Date(NOW),
      picked: new Picked(),
      keep: "yes",
    });
    expect(dropped.sort()).toEqual(["onSelect", "picked", "when"]);
    expect(values).toEqual({ keep: "yes" });
  });

  it("omits undefined without calling it a loss", () => {
    const { values, dropped } = sanitizeDraftValues({ a: undefined, b: "x" });
    expect(dropped).toEqual([]);
    expect(values).toEqual({ b: "x" });
  });

  it("survives a cycle instead of overflowing the stack", () => {
    const a: Record<string, unknown> = { name: "a" };
    a["self"] = a;
    const { values, dropped } = sanitizeDraftValues({ a });
    expect(dropped).toEqual(["a.self"]);
    expect(values).toEqual({ a: { name: "a" } });
  });

  it("turns a non-finite number into null rather than losing the field", () => {
    expect(sanitizeDraftValues({ lat: NaN, lon: Infinity }).values).toEqual({
      lat: null,
      lon: null,
    });
  });
});

describe("draftHasContent", () => {
  const blank = { address: "", callDate: "2026-10-05", jobType: "insurance", methods: [] };

  it("is false for a form nobody touched", () => {
    expect(draftHasContent({ ...blank }, blank)).toBe(false);
  });

  it("is false when only the form's own defaults are set", () => {
    expect(
      draftHasContent({ address: "", callDate: "2026-10-05", jobType: "insurance" }, blank),
    ).toBe(false);
  });

  it("is true as soon as one field differs from the blank form", () => {
    expect(draftHasContent({ ...blank, address: "123 Elm Street" }, blank)).toBe(true);
  });

  it("is true for a changed default, not just a filled blank", () => {
    expect(draftHasContent({ ...blank, jobType: "cash" }, blank)).toBe(true);
  });

  it("ignores empty arrays and objects", () => {
    expect(draftHasContent({ ...blank, methods: [], account: {} }, blank)).toBe(false);
  });
});

describe("draftAge", () => {
  it("reads the way someone coming back to a tab would say it", () => {
    expect(draftAge(NOW - 10_000, NOW)).toBe("just now");
    expect(draftAge(NOW - 60_000, NOW)).toBe("1 minute ago");
    expect(draftAge(NOW - 4 * 60_000, NOW)).toBe("4 minutes ago");
    expect(draftAge(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(draftAge(NOW - 5 * 60 * 60_000, NOW)).toBe("5 hours ago");
    expect(draftAge(NOW - 50 * 60 * 60_000, NOW)).toBe("2 days ago");
  });

  it("never reads as the future when the clock disagrees", () => {
    expect(draftAge(NOW + 60_000, NOW)).toBe("just now");
  });
});

describe("makeDraftSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("writes once for a burst of typing, with the last value", () => {
    const written: string[] = [];
    const saver = makeDraftSaver<string>((v) => written.push(v), 800);
    saver.queue("1");
    vi.advanceTimersByTime(200);
    saver.queue("12");
    vi.advanceTimersByTime(200);
    saver.queue("123 Elm Street");
    expect(written).toEqual([]);
    vi.advanceTimersByTime(800);
    expect(written).toEqual(["123 Elm Street"]);
  });

  it("writes again after the next pause", () => {
    const written: string[] = [];
    const saver = makeDraftSaver<string>((v) => written.push(v), 800);
    saver.queue("a");
    vi.advanceTimersByTime(800);
    saver.queue("ab");
    vi.advanceTimersByTime(800);
    expect(written).toEqual(["a", "ab"]);
  });

  it("flush writes what is pending immediately and only once", () => {
    const written: string[] = [];
    const saver = makeDraftSaver<string>((v) => written.push(v), 800);
    saver.queue("a");
    saver.flush();
    expect(written).toEqual(["a"]);
    vi.advanceTimersByTime(5_000);
    expect(written).toEqual(["a"]);
  });

  it("flush with nothing pending writes nothing", () => {
    const written: string[] = [];
    const saver = makeDraftSaver<string>((v) => written.push(v), 800);
    saver.flush();
    expect(written).toEqual([]);
  });

  it("cancel drops the pending write — the draft was just cleared", () => {
    const written: string[] = [];
    const saver = makeDraftSaver<string>((v) => written.push(v), 800);
    saver.queue("a");
    saver.cancel();
    vi.advanceTimersByTime(5_000);
    expect(written).toEqual([]);
  });
});
