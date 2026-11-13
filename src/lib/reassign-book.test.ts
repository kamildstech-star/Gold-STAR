import { describe, expect, it } from "vitest";

import {
  ALL,
  EMPTY_FILTER,
  NO_OFFICE,
  allSelected,
  bookSizes,
  departedHolders,
  describeTasks,
  deselectIds,
  filterBook,
  fmtDaysAgo,
  fmtValue,
  isCadenceTask,
  isReassignmentHistory,
  officeOptions,
  orderSources,
  pruneSelection,
  rankTargets,
  reassignBlocked,
  selectIds,
  stageOptions,
  tasksForSelection,
  toggleId,
  type BookRow,
  type BookTask,
  type Person,
} from "./reassign-book";

const row = (over: Partial<BookRow> & { id: string }): BookRow => ({
  name: over.id,
  location_id: null,
  office: null,
  stage: null,
  stage_name: null,
  status: "prospect",
  last_touch_at: null,
  estimated_annual_value: null,
  days_in_pipeline: 0,
  is_demo: false,
  labels: [],
  ...over,
});

const NY = "loc-ny";
const GA = "loc-ga";

const book: BookRow[] = [
  row({
    id: "a",
    name: "Acme Towers",
    location_id: NY,
    office: "NY",
    stage: "ready",
    stage_name: "Ready",
  }),
  row({
    id: "b",
    name: "Beacon PM",
    location_id: GA,
    office: "GA",
    stage: "target",
    stage_name: "Target",
  }),
  row({
    id: "c",
    name: "Cobalt Realty",
    location_id: GA,
    office: "GA",
    stage: "ready",
    stage_name: "Ready",
  }),
  row({ id: "d", name: "Delta Homes", location_id: null, stage: "ready", stage_name: "Ready" }),
];

describe("filtering the book", () => {
  it("returns everything on the empty filter", () => {
    expect(filterBook(book, EMPTY_FILTER).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters by office, including accounts with no office", () => {
    expect(filterBook(book, { ...EMPTY_FILTER, office: GA }).map((r) => r.id)).toEqual(["b", "c"]);
    expect(filterBook(book, { ...EMPTY_FILTER, office: NO_OFFICE }).map((r) => r.id)).toEqual([
      "d",
    ]);
  });

  it("filters by stage and search together", () => {
    expect(filterBook(book, { office: ALL, stage: "ready", q: "co" }).map((r) => r.id)).toEqual([
      "c",
    ]);
  });

  it("search matches office and stage names, case-insensitively", () => {
    expect(filterBook(book, { ...EMPTY_FILTER, q: "TARGET" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterBook(book, { ...EMPTY_FILTER, q: "ga" }).map((r) => r.id)).toEqual(["b", "c"]);
  });

  it("lists offices and stages with counts", () => {
    expect(officeOptions(book)).toEqual([
      { id: GA, label: "GA", count: 2 },
      { id: NY, label: "NY", count: 1 },
      { id: NO_OFFICE, label: "No office", count: 1 },
    ]);
    expect(stageOptions(book)).toEqual([
      { key: "ready", label: "Ready", count: 3 },
      { key: "target", label: "Target", count: 1 },
    ]);
  });
});

describe("selecting a slice", () => {
  it("toggles without mutating the previous set", () => {
    const s0 = new Set<string>();
    const s1 = toggleId(s0, "a");
    const s2 = toggleId(s1, "a");
    expect([...s1]).toEqual(["a"]);
    expect(s2.size).toBe(0);
    expect(s0.size).toBe(0);
  });

  it("select all in filter adds only the visible rows and keeps earlier picks", () => {
    const visible = filterBook(book, { ...EMPTY_FILTER, office: GA });
    const s = selectIds(
      new Set(["a"]),
      visible.map((r) => r.id),
    );
    expect([...s].sort()).toEqual(["a", "b", "c"]);
    expect(allSelected(s, visible)).toBe(true);
    expect(allSelected(s, book)).toBe(false);
    expect([
      ...deselectIds(
        s,
        visible.map((r) => r.id),
      ),
    ]).toEqual(["a"]);
  });

  it("allSelected is false for an empty view", () => {
    expect(allSelected(new Set(["a"]), [])).toBe(false);
  });

  it("prunes ids that left the book after a slice moved", () => {
    const s = pruneSelection(new Set(["a", "b", "zzz"]), book);
    expect([...s].sort()).toEqual(["a", "b"]);
  });
});

const people: Person[] = [
  { user_id: "u-gone", full_name: "Gone Rep", is_active: false, primary_location_id: NY },
  { user_id: "u-gone-empty", full_name: "Gone Empty", is_active: false, primary_location_id: NY },
  { user_id: "u-ny", full_name: "Nia York", is_active: true, primary_location_id: NY },
  { user_id: "u-ga", full_name: "Gus Atlanta", is_active: true, primary_location_id: GA },
  { user_id: "u-nowhere", full_name: "Ann Office", is_active: true, primary_location_id: null },
];

const sizes = bookSizes([
  { assigned_rep: "u-gone" },
  { assigned_rep: "u-gone" },
  { assigned_rep: "u-ny" },
  { assigned_rep: null },
]);

describe("who has left and who can take the book", () => {
  it("counts live accounts per rep", () => {
    expect(sizes.get("u-gone")).toBe(2);
    expect(sizes.get("u-ny")).toBe(1);
    expect(sizes.has("u-ga")).toBe(false);
  });

  it("surfaces deactivated reps who still hold accounts, biggest first", () => {
    expect(departedHolders(people, sizes).map((h) => [h.person.user_id, h.count])).toEqual([
      ["u-gone", 2],
    ]);
  });

  it("orders sources: departed holders, then holders, then everyone — nobody dropped", () => {
    expect(orderSources(people, sizes).map((p) => p.user_id)).toEqual([
      "u-gone",
      "u-ny",
      "u-nowhere",
      "u-gone-empty",
      "u-ga",
    ]);
  });

  it("targets are active, exclude the source, and carry office and book size", () => {
    const officeOf = (id: string | null | undefined) =>
      id === NY ? "NY" : id === GA ? "GA" : null;
    const t = rankTargets(people, sizes, "u-ny", officeOf);
    expect(t.map((x) => [x.person.user_id, x.office, x.count])).toEqual([
      ["u-ga", "GA", 0],
      ["u-nowhere", null, 0],
    ]);
    // Without a source picked, the New York rep is offered too, under NY.
    expect(rankTargets(people, sizes, null, officeOf).map((x) => x.person.user_id)).toEqual([
      "u-ga",
      "u-ny",
      "u-nowhere",
    ]);
  });
});

describe("open work that travels with the accounts", () => {
  const tasks: BookTask[] = [
    {
      id: "t1",
      account_id: "a",
      entity_type: null,
      entity_id: null,
      cadence_key: null,
      source: "manual",
    },
    {
      id: "t2",
      account_id: "a",
      entity_type: null,
      entity_id: null,
      cadence_key: "quarterly:a:2026-Q3",
      source: "cadence",
    },
    {
      id: "t3",
      account_id: null,
      entity_type: "account",
      entity_id: "b",
      cadence_key: null,
      source: "automation",
    },
    {
      id: "t4",
      account_id: "c",
      entity_type: null,
      entity_id: null,
      cadence_key: null,
      source: "followup_rule",
    },
    {
      id: "t5",
      account_id: null,
      entity_type: "job",
      entity_id: "j1",
      cadence_key: null,
      source: "manual",
    },
  ];

  it("classifies cadence, automation and follow-up-rule tasks as the system's", () => {
    expect(isCadenceTask(tasks[0]!)).toBe(false);
    expect(isCadenceTask(tasks[1]!)).toBe(true);
    expect(isCadenceTask(tasks[2]!)).toBe(true);
    expect(isCadenceTask(tasks[3]!)).toBe(true);
  });

  it("counts only tasks on the selected accounts, via account_id or entity link", () => {
    expect(tasksForSelection(tasks, new Set(["a", "b"]))).toEqual({
      total: 3,
      cadence: 2,
      manual: 1,
    });
    expect(tasksForSelection(tasks, new Set(["c"]))).toEqual({ total: 1, cadence: 1, manual: 0 });
    expect(tasksForSelection(tasks, new Set())).toEqual({ total: 0, cadence: 0, manual: 0 });
  });

  it("describes the count for the checkbox label", () => {
    expect(describeTasks({ total: 0, cadence: 0, manual: 0 })).toBe(
      "No open tasks on these accounts",
    );
    expect(describeTasks({ total: 1, cadence: 0, manual: 1 })).toBe("1 open task (1 manual)");
    expect(describeTasks({ total: 3, cadence: 2, manual: 1 })).toBe(
      "3 open tasks (1 manual, 2 cadence/automation)",
    );
  });
});

describe("guards and formatting", () => {
  const ok = {
    fromId: "u-gone",
    toId: "u-ny",
    selectedCount: 2,
    reason: "rep_departed",
    doDifferently: "",
  };

  it("blocks an incomplete submit with the first missing thing", () => {
    expect(reassignBlocked({ ...ok, fromId: "" })).toMatch(/whose book/);
    expect(reassignBlocked({ ...ok, toId: "" })).toMatch(/go to/);
    expect(reassignBlocked({ ...ok, toId: "u-gone" })).toMatch(/same person/);
    expect(reassignBlocked({ ...ok, selectedCount: 0 })).toMatch(/at least one/);
  });

  it("requires the lesson only for a six-month handover", () => {
    expect(reassignBlocked(ok)).toBeNull();
    expect(reassignBlocked({ ...ok, reason: "no_close_6_months" })).toMatch(/differently/);
    expect(
      reassignBlocked({ ...ok, reason: "no_close_6_months", doDifferently: "Go via the RFM." }),
    ).toBeNull();
  });

  it("recognizes the history line this page writes", () => {
    expect(isReassignmentHistory("Reassigned from A to B by C — Rep left the company")).toBe(true);
    expect(isReassignmentHistory("Moved back to pipeline — Deal fell through")).toBe(false);
    expect(isReassignmentHistory(null)).toBe(false);
  });

  it("formats value and last touch", () => {
    expect(fmtValue(125000.4)).toBe("$125,000");
    expect(fmtValue(null)).toBe("—");
    const now = Date.UTC(2026, 8, 9, 12);
    expect(fmtDaysAgo(null, now)).toBe("Never");
    expect(fmtDaysAgo(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe("3d ago");
    expect(fmtDaysAgo(new Date(now - 3600_000).toISOString(), now)).toBe("Today");
  });
});
