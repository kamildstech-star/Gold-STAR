import { describe, expect, it } from "vitest";
import { mergeColumnOrder } from "./table-prefs";

const AVAILABLE = ["job_number", "job_name", "status", "call_date", "address"] as const;
type Key = (typeof AVAILABLE)[number];

describe("mergeColumnOrder", () => {
  it("falls back to the table's own order when nothing is saved", () => {
    expect(mergeColumnOrder(AVAILABLE, undefined)).toEqual([...AVAILABLE]);
    expect(mergeColumnOrder(AVAILABLE, null)).toEqual([...AVAILABLE]);
    expect(mergeColumnOrder(AVAILABLE, [])).toEqual([...AVAILABLE]);
  });

  it("honors a saved order", () => {
    const saved: Key[] = ["address", "job_name", "status", "call_date", "job_number"];
    expect(mergeColumnOrder(AVAILABLE, saved)).toEqual(saved);
  });

  it("keeps a column added since the order was saved, beside the one it ships after", () => {
    // Saved before `call_date` existed.
    const saved: Key[] = ["address", "job_number", "job_name", "status"];
    expect(mergeColumnOrder(AVAILABLE, saved)).toEqual([
      "address",
      "job_number",
      "job_name",
      "status",
      "call_date",
    ]);
  });

  it("puts a new leading column at the front rather than the end", () => {
    const available = ["picked", "a", "b"] as const;
    expect(mergeColumnOrder(available, ["b", "a"])).toEqual(["picked", "b", "a"]);
  });

  it("keeps several new columns in their shipped relative order", () => {
    const available = ["a", "b", "c", "d"] as const;
    expect(mergeColumnOrder(available, ["d", "a"])).toEqual(["d", "a", "b", "c"]);
  });

  it("ignores a saved column the table no longer has", () => {
    const saved = ["gone", "address", "job_number"] as unknown as Key[];
    expect(mergeColumnOrder(AVAILABLE, saved)).not.toContain("gone");
    expect(mergeColumnOrder(AVAILABLE, saved)).toEqual([
      "address",
      "job_number",
      "job_name",
      "status",
      "call_date",
    ]);
  });

  it("survives an order made entirely of columns that no longer exist", () => {
    const saved = ["gone", "also_gone"] as unknown as Key[];
    expect(mergeColumnOrder(AVAILABLE, saved)).toEqual([...AVAILABLE]);
  });

  it("never repeats a column, even from a duplicated saved entry", () => {
    const saved: Key[] = ["status", "status", "job_number"];
    const out = mergeColumnOrder(AVAILABLE, saved);
    expect(new Set(out).size).toBe(out.length);
    expect(out.length).toBe(AVAILABLE.length);
  });

  it("returns every available column, whatever was saved", () => {
    const out = mergeColumnOrder(AVAILABLE, ["call_date"]);
    expect([...out].sort()).toEqual([...AVAILABLE].sort());
  });
});
