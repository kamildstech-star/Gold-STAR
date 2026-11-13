/**
 * The job album used to stop at 600 photos and say nothing. These tests hold
 * the two rules that replaced the cap: pages are keyset (a cursor is the last
 * row seen, so uploads landing mid-scroll cannot shift a page boundary), and
 * counts come from the database (so a header is right before its room has
 * finished loading).
 *
 * Every clock and time zone here is explicit. Nothing defaults to Date.now()
 * or to the machine's zone, so these pass the same on CI as on a laptop in New
 * York.
 */
import { describe, expect, it } from "vitest";

import {
  MATCH_ALL,
  albumAfter,
  albumScopeFilter,
  combine,
  compareAlbum,
  countText,
  dateRows,
  dayKey,
  dayLabel,
  documentAfter,
  isMatchAll,
  matches,
  mergeNewest,
  pathLabel,
  planRooms,
  reconcile,
  splitPage,
  tallyFromDayRows,
  tallyFromTotals,
  toMicros,
  toPostgrestOr,
  type AlbumCursor,
  type DocumentCursor,
  type Filter,
  type FolderLite,
} from "./job-photo-paging";

type Row = { id: string; captured_at: string | null; created_at: string; folder_id: string | null };

/** What the database does for one page: filter, order, limit + 1. */
function page(all: Row[], filter: Filter, limit: number) {
  const hits = all.filter((r) => isMatchAll(filter) || matches(r, filter)).sort(compareAlbum);
  return splitPage(hits.slice(0, limit + 1), limit);
}

function walk(all: Row[], limit: number, scope: Filter = MATCH_ALL) {
  const seen: string[] = [];
  let after: AlbumCursor | null = null;
  for (let guard = 0; guard < 1000; guard++) {
    const filter = combine(scope, after ? albumAfter(after) : MATCH_ALL);
    const { rows, hasMore } = page(all, filter, limit);
    seen.push(...rows.map((r) => r.id));
    const last = rows[rows.length - 1];
    if (!hasMore || !last) break;
    after = { capturedAt: last.captured_at, createdAt: last.created_at, id: last.id };
  }
  return seen;
}

/** Ties on both timestamps, missing capture times, microsecond differences. */
const ROWS: Row[] = [
  {
    id: "01A",
    captured_at: "2026-10-05T15:00:00.000000+00:00",
    created_at: "2026-10-05T15:10:00+00:00",
    folder_id: "k",
  },
  {
    id: "01B",
    captured_at: "2026-10-05T15:00:00.000000+00:00",
    created_at: "2026-10-05T15:10:00+00:00",
    folder_id: null,
  },
  {
    id: "01C",
    captured_at: "2026-10-05T15:00:00.000000+00:00",
    created_at: "2026-10-05T15:11:00+00:00",
    folder_id: "k",
  },
  {
    id: "01D",
    captured_at: "2026-10-05T15:00:00.000001+00:00",
    created_at: "2026-10-05T15:10:00+00:00",
    folder_id: "b",
  },
  {
    id: "01E",
    captured_at: "2026-10-04T09:00:00.5+00:00",
    created_at: "2026-10-05T08:00:00+00:00",
    folder_id: null,
  },
  { id: "01F", captured_at: null, created_at: "2026-10-06T12:00:00+00:00", folder_id: "k" },
  { id: "01G", captured_at: null, created_at: "2026-10-06T12:00:00+00:00", folder_id: null },
  { id: "01H", captured_at: null, created_at: "2026-10-01T12:00:00+00:00", folder_id: "b" },
  {
    id: "01I",
    captured_at: "2026-09-30T23:59:59.999999+00:00",
    created_at: "2026-10-01T00:00:00+00:00",
    folder_id: "k",
  },
];

const ORDER = [...ROWS].sort(compareAlbum).map((r) => r.id);

describe("album order", () => {
  it("is captured newest first, no capture time last, then upload, then id", () => {
    expect(ORDER).toEqual(["01D", "01C", "01B", "01A", "01E", "01I", "01G", "01F", "01H"]);
  });
});

describe("keyset paging over the album", () => {
  it.each([1, 2, 3, 4, 5, 8, 9, 10])(
    "returns every row exactly once, in order, %i at a time",
    (n) => {
      expect(walk(ROWS, n)).toEqual(ORDER);
    },
  );

  it("walks one room the same way when the room's folders are part of the filter", () => {
    const scope = albumScopeFilter({ folderIds: ["k"], includeUnfiled: false });
    const kitchen = ORDER.filter((id) => ROWS.find((r) => r.id === id)!.folder_id === "k");
    for (const n of [1, 2, 3]) expect(walk(ROWS, n, scope)).toEqual(kitchen);
  });

  it("walks Unfiled plus a folder the tree cannot name, as one room", () => {
    const scope = albumScopeFilter({ folderIds: ["b"], includeUnfiled: true });
    const want = ORDER.filter((id) => {
      const f = ROWS.find((r) => r.id === id)!.folder_id;
      return f == null || f === "b";
    });
    expect(walk(ROWS, 2, scope)).toEqual(want);
  });

  it("is not moved by uploads that land while someone is scrolling", () => {
    // Offset paging shifts under every new row; a cursor does not. Page one,
    // then three newer photos land, then the rest is read.
    const first = page(ROWS, MATCH_ALL, 3);
    const last = first.rows[first.rows.length - 1]!;
    const landed: Row[] = [
      {
        id: "02A",
        captured_at: "2026-10-07T10:00:00+00:00",
        created_at: "2026-10-07T10:00:01+00:00",
        folder_id: null,
      },
      {
        id: "02B",
        captured_at: "2026-10-07T10:00:00+00:00",
        created_at: "2026-10-07T10:00:02+00:00",
        folder_id: "k",
      },
      { id: "02C", captured_at: null, created_at: "2026-10-07T10:00:03+00:00", folder_id: null },
    ];
    const grown = [...ROWS, ...landed];
    const rest: string[] = [];
    let after: AlbumCursor | null = {
      capturedAt: last.captured_at,
      createdAt: last.created_at,
      id: last.id,
    };
    while (after) {
      const { rows, hasMore } = page(grown, albumAfter(after), 2);
      rest.push(...rows.map((r) => r.id));
      const l = rows[rows.length - 1];
      after =
        hasMore && l ? { capturedAt: l.captured_at, createdAt: l.created_at, id: l.id } : null;
    }
    const seen = [...first.rows.map((r) => r.id), ...rest];
    // Every photo that was there when scrolling began, once each. The newly
    // landed one with no capture time sorts last, so it is picked up too.
    for (const id of ORDER) expect(seen.filter((x) => x === id)).toHaveLength(1);
    expect(seen).toContain("02C");
  });

  it("keeps microseconds: a cursor on .000000 does not swallow the row at .000001", () => {
    expect(
      toMicros("2026-10-05T15:00:00.000001+00:00") - toMicros("2026-10-05T15:00:00+00:00"),
    ).toBe(1n);
    expect(toMicros("2026-10-05T11:00:00-04:00")).toBe(toMicros("2026-10-05T15:00:00Z"));
    expect(toMicros("2026-10-05T15:00:00.5+00")).toBe(toMicros("2026-10-05T15:00:00.500000+00:00"));
  });
});

describe("keyset paging over documents", () => {
  it("returns every document exactly once with tied upload times", () => {
    const docs = [
      { id: "b", created_at: "2026-10-05T10:00:00+00:00" },
      { id: "a", created_at: "2026-10-05T10:00:00+00:00" },
      { id: "c", created_at: "2026-10-05T10:00:00+00:00" },
      { id: "d", created_at: "2026-10-04T10:00:00+00:00" },
    ];
    const order = ["c", "b", "a", "d"];
    const sorted = (rows: typeof docs) =>
      [...rows].sort((x, y) =>
        x.created_at === y.created_at
          ? x.id < y.id
            ? 1
            : -1
          : x.created_at < y.created_at
            ? 1
            : -1,
      );
    const seen: string[] = [];
    let after: DocumentCursor | null = null;
    for (let i = 0; i < 10; i++) {
      const filter = after ? documentAfter(after) : MATCH_ALL;
      const hits = sorted(docs.filter((d) => isMatchAll(filter) || matches(d as never, filter)));
      const { rows, hasMore } = splitPage(hits.slice(0, 2), 1);
      seen.push(...rows.map((r) => r.id));
      if (!hasMore) break;
      after = { createdAt: rows[0]!.created_at, id: rows[0]!.id };
    }
    expect(seen).toEqual(order);
  });
});

describe("the PostgREST filter text", () => {
  it("quotes every value, since a timestamp's colons and dots are filter syntax", () => {
    const text = toPostgrestOr(
      albumAfter({
        capturedAt: "2026-10-05T15:00:00.123456+00:00",
        createdAt: "2026-10-05T15:10:00+00:00",
        id: "01ABC",
      }),
    );
    expect(text).toBe(
      [
        'captured_at.lt."2026-10-05T15:00:00.123456+00:00"',
        'and(captured_at.eq."2026-10-05T15:00:00.123456+00:00",created_at.lt."2026-10-05T15:10:00+00:00")',
        'and(captured_at.eq."2026-10-05T15:00:00.123456+00:00",created_at.eq."2026-10-05T15:10:00+00:00",id.lt."01ABC")',
        "captured_at.is.null",
      ].join(","),
    );
  });

  it("keeps to the no-capture-time tail once the cursor is in it", () => {
    expect(
      toPostgrestOr(
        albumAfter({ capturedAt: null, createdAt: "2026-10-06T12:00:00+00:00", id: "01G" }),
      ),
    ).toBe(
      'and(captured_at.is.null,created_at.lt."2026-10-06T12:00:00+00:00"),and(captured_at.is.null,created_at.eq."2026-10-06T12:00:00+00:00",id.lt."01G")',
    );
  });

  it("distributes a room's folders over the keyset, because a query takes one or=", () => {
    const f = combine(
      albumScopeFilter({ folderIds: ["f1", "f2"], includeUnfiled: true }),
      documentAfter({ createdAt: "2026-10-05T10:00:00+00:00", id: "x" }),
    );
    expect(f).toHaveLength(4);
    expect(toPostgrestOr(f)).toBe(
      [
        'and(folder_id.is.null,created_at.lt."2026-10-05T10:00:00+00:00")',
        'and(folder_id.is.null,created_at.eq."2026-10-05T10:00:00+00:00",id.lt."x")',
        'and(folder_id.in.("f1","f2"),created_at.lt."2026-10-05T10:00:00+00:00")',
        'and(folder_id.in.("f1","f2"),created_at.eq."2026-10-05T10:00:00+00:00",id.lt."x")',
      ].join(","),
    );
  });

  it("escapes a quote or backslash inside a value", () => {
    expect(toPostgrestOr([[{ col: "id", op: "lt", value: 'a"b\\c' }]])).toBe('id.lt."a\\"b\\\\c"');
  });

  it("adds no filter at all for every album photo on the first page", () => {
    expect(isMatchAll(combine(albumScopeFilter({}), MATCH_ALL))).toBe(true);
    expect(isMatchAll(albumScopeFilter({ folderIds: ["a"] }))).toBe(false);
  });
});

describe("splitPage", () => {
  it("knows there is more from the look-ahead row, without a second request", () => {
    expect(splitPage([1, 2, 3, 4], 3)).toEqual({ rows: [1, 2, 3], hasMore: true });
    expect(splitPage([1, 2, 3], 3)).toEqual({ rows: [1, 2, 3], hasMore: false });
    expect(splitPage([], 3)).toEqual({ rows: [], hasMore: false });
  });
});

describe("days", () => {
  it("files a photo on the day it was taken where the viewer is", () => {
    // 02:30 UTC on the 5th is 22:30 on the 4th in New York.
    expect(dayKey("2026-10-05T02:30:00Z", "America/New_York")).toBe("2026-10-04");
    expect(dayKey("2026-10-05T02:30:00Z", "UTC")).toBe("2026-10-05");
    expect(dayKey("2026-10-05T02:30:00.123456+00:00", "Asia/Tokyo")).toBe("2026-10-05");
  });

  it("labels a day the way the grid always has", () => {
    expect(dayLabel("2026-10-04", "en-US")).toBe("October 4, 2026");
  });
});

const day = (source: "album" | "document", folder_id: string | null, d: string, n: number) => ({
  source,
  folder_id,
  day: d,
  n,
});

describe("the tally", () => {
  it("folds the counting function's rows into totals, folders and days", () => {
    const t = tallyFromDayRows([
      day("album", "k", "2026-10-05", 300),
      day("album", "k", "2026-10-04", 112),
      day("album", null, "2026-10-05", 190),
      day("document", null, "2026-10-05", 7),
      { source: "album", folder_id: "b", day: "2026-10-05", n: "4" },
    ]);
    expect(t.total).toBe(613);
    expect(t.albumTotal).toBe(606);
    expect(t.documentTotal).toBe(7);
    expect(t.unfiled).toBe(190);
    expect(t.byFolder).toEqual({ k: 412, b: 4 });
    expect(t.byDay!.get("k")!.get("2026-10-04")).toBe(112);
    expect(t.byDay!.get("documents")!.get("2026-10-05")).toBe(7);
  });

  it("past 600 — the number the old read stopped at — the count is still the count", () => {
    const t = tallyFromDayRows([day("album", null, "2026-10-05", 1834)]);
    expect(t.total).toBe(1834);
  });

  it("without the counting function, totals and folders stay exact and days are unknown", () => {
    const t = tallyFromTotals({ albumTotal: 900, documentTotal: 12, byFolder: { k: 400, b: 100 } });
    expect(t.total).toBe(912);
    expect(t.unfiled).toBe(400);
    expect(t.byDay).toBeNull();
  });
});

const TREE: FolderLite[] = [
  { id: "u100", name: "Unit 100", parent_folder_id: null },
  { id: "k1", name: "Kitchen", parent_folder_id: "u100" },
  { id: "k2", name: "Kitchen ", parent_folder_id: "u100" }, // a twin on the chaser's album
  { id: "bath", name: "Bathroom", parent_folder_id: null },
];

describe("planning rooms before a photo is fetched", () => {
  const tally = tallyFromDayRows([
    day("album", "k1", "2026-10-05", 300),
    day("album", "k2", "2026-10-04", 12),
    day("album", "bath", "2026-10-05", 5),
    day("album", null, "2026-10-05", 40),
    day("album", "gone", "2026-10-03", 2),
    day("document", null, "2026-10-05", 7),
  ]);

  it("one room per folder path, with the database's count, in claim-package order", () => {
    const rooms = planRooms(tally, TREE);
    expect(rooms.map((r) => [r.label, r.total])).toEqual([
      ["Bathroom", 5],
      ["Unit 100 · Kitchen", 312],
      ["Unfiled", 42],
      ["Documents", 7],
    ]);
    expect(pathLabel(TREE, "k2")).toBe("Unit 100 · Kitchen");
  });

  it("merges a twin folder's days and pages both folders as one room", () => {
    const kitchen = planRooms(tally, TREE).find((r) => r.label === "Unit 100 · Kitchen")!;
    expect(kitchen.scope.folderIds!.sort()).toEqual(["k1", "k2"]);
    expect(kitchen.scope.includeUnfiled).toBe(false);
    expect(Object.fromEntries(kitchen.days!)).toEqual({ "2026-10-05": 300, "2026-10-04": 12 });
  });

  it("files a folder the tree cannot name under Unfiled, as the old read did", () => {
    const unfiled = planRooms(tally, TREE).find((r) => r.key === "unfiled")!;
    expect(unfiled.scope).toEqual({ folderIds: ["gone"], includeUnfiled: true });
    expect(Object.fromEntries(unfiled.days!)).toEqual({ "2026-10-05": 40, "2026-10-03": 2 });
  });

  it("a folder view shows only its folders — no Unfiled, no Documents", () => {
    const rooms = planRooms(tally, TREE, ["u100", "k1"]);
    expect(rooms.map((r) => [r.label, r.total])).toEqual([["Unit 100 · Kitchen", 300]]);
  });

  it("an empty job plans no rooms", () => {
    expect(planRooms(tallyFromDayRows([]), TREE)).toEqual([]);
  });
});

describe("reconciling the count with what has loaded", () => {
  it("prints the database's number while a room is still loading", () => {
    expect(reconcile(412, 120, false)).toEqual({ count: 412, exact: true, remaining: 292 });
  });

  it("trusts the rows once the room is fully loaded — they were read after the count", () => {
    expect(reconcile(412, 410, true)).toEqual({ count: 410, exact: true, remaining: 0 });
    expect(reconcile(412, 413, true)).toEqual({ count: 413, exact: true, remaining: 0 });
  });

  it("never prints less than is on screen when an upload landed after the count", () => {
    expect(reconcile(100, 101, false).count).toBe(101);
  });

  it("without a count, shows what has loaded as a floor", () => {
    const r = reconcile(null, 48, false);
    expect(countText(r)).toBe("48+");
    expect(countText(reconcile(null, 48, true))).toBe("48");
  });
});

describe("date rows", () => {
  const photo = (id: string, takenAt: string) => ({ id, takenAt });
  const loaded = [
    photo("a", "2026-10-05T15:00:00Z"),
    photo("b", "2026-10-05T02:30:00Z"), // the 4th in New York
    photo("c", "2026-10-04T12:00:00Z"),
    photo("d", "2026-10-06T12:00:00Z"), // no capture time: sorted last, dated by upload
  ];

  it("groups by the viewer's day, newest day first", () => {
    const rows = dateRows(loaded, null, true, "America/New_York", "en-US");
    expect(rows.map((r) => [r.day, r.photos.map((p) => p.id)])).toEqual([
      ["2026-10-06", ["d"]],
      ["2026-10-05", ["a"]],
      ["2026-10-04", ["b", "c"]],
    ]);
    expect(rows[2]!.label).toBe("October 4, 2026");
  });

  it("prints the database's count for a day still loading", () => {
    const days = new Map([
      ["2026-10-05", 61],
      ["2026-10-04", 2],
      ["2026-10-06", 1],
    ]);
    const rows = dateRows(loaded, days, false, "America/New_York", "en-US");
    expect(rows.find((r) => r.day === "2026-10-05")).toMatchObject({ count: 61, exact: true });
    expect(rows.find((r) => r.day === "2026-10-04")).toMatchObject({ count: 2, exact: true });
  });

  it("marks a day as a floor when the database could not be asked and the room is not done", () => {
    const rows = dateRows(loaded, null, false, "UTC", "en-US");
    expect(rows.every((r) => !r.exact)).toBe(true);
    expect(countText(rows.find((r) => r.day === "2026-10-05")!)).toBe("2+");
  });
});

describe("merging the newest across album and documents", () => {
  const p = (id: string, takenAt: string) => ({ id, takenAt });

  it("interleaves by time and stops at n", () => {
    const m = mergeNewest(
      { buf: [p("a1", "2026-10-05T12:00:00Z"), p("a2", "2026-10-03T12:00:00Z")], done: true },
      { buf: [p("d1", "2026-10-04T12:00:00Z")], done: true },
      2,
    );
    expect(m.out.map((x) => x.id)).toEqual(["a1", "d1"]);
    expect(m.a.map((x) => x.id)).toEqual(["a2"]);
    expect(m.b).toEqual([]);
  });

  it("never emits past a source that has run dry in memory but not on the server", () => {
    // The next document might be newer than a2; emitting a2 now could show it
    // ahead of a picture taken after it.
    const m = mergeNewest(
      { buf: [p("a1", "2026-10-05T12:00:00Z"), p("a2", "2026-10-01T12:00:00Z")], done: false },
      { buf: [p("d1", "2026-10-04T12:00:00Z")], done: false },
      5,
    );
    expect(m.out.map((x) => x.id)).toEqual(["a1", "d1"]);
    expect(m.a.map((x) => x.id)).toEqual(["a2"]);
  });

  it("drains one source completely once the other is finished", () => {
    const m = mergeNewest(
      { buf: [p("a1", "2026-10-05T12:00:00Z"), p("a2", "2026-10-01T12:00:00Z")], done: true },
      { buf: [], done: true },
      5,
    );
    expect(m.out.map((x) => x.id)).toEqual(["a1", "a2"]);
  });
});
