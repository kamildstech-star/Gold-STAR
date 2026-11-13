import { describe, expect, it } from "vitest";
import {
  isPrintableDocument,
  printSkipReason,
  pruneSelection,
  selectAllState,
  selectedInOrder,
  toggleAllShown,
} from "./document-print-selection";

const rows = [
  { id: "a", name: "contract.pdf", mime: "application/pdf" },
  { id: "b", name: "sign-in scan.PNG", mime: null },
  { id: "c", name: "photo.jpg", mime: "image/jpeg" },
  { id: "d", name: "estimate.esx", mime: "application/octet-stream" },
  { id: "e", name: "notes.txt", mime: "text/plain" },
];

describe("isPrintableDocument", () => {
  it("takes PDFs and images (paper scans), not ESX, text or other files", () => {
    expect(rows.map((r) => [r.id, isPrintableDocument(r)])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
      ["d", false],
      ["e", false],
    ]);
  });

  it("does not print an SVG — it is live markup, not a picture", () => {
    expect(isPrintableDocument({ name: "logo.svg", mime: "image/svg+xml" })).toBe(false);
  });

  it("gives the Not-included reason only for what cannot print", () => {
    expect(printSkipReason(rows[0])).toBeNull();
    expect(printSkipReason(rows[1])).toBeNull();
    expect(printSkipReason(rows[3])).toBe("not a PDF or an image");
  });
});

describe("selectedInOrder", () => {
  it("keeps list order, whatever order they were ticked in, and every kind", () => {
    expect(selectedInOrder(rows, new Set(["e", "b", "a"])).map((r) => r.id)).toEqual([
      "a",
      "b",
      "e",
    ]);
  });

  it("skips ids no longer on the record", () => {
    expect(selectedInOrder(rows, new Set(["gone", "c"])).map((r) => r.id)).toEqual(["c"]);
  });
});

describe("select all shown", () => {
  const shown = rows.slice(0, 3);

  it("is off with nothing shown or nothing ticked", () => {
    expect(selectAllState([], new Set(["a"]))).toBe(false);
    expect(selectAllState(shown, new Set())).toBe(false);
    // A tick in another folder does not count toward this view.
    expect(selectAllState(shown, new Set(["d"]))).toBe(false);
  });

  it("is part-way when some shown rows are ticked, on when all are", () => {
    expect(selectAllState(shown, new Set(["a"]))).toBe("indeterminate");
    expect(selectAllState(shown, new Set(["a", "b", "c", "d"]))).toBe(true);
  });

  it("ticks every shown row and keeps ticks made in other folders", () => {
    const next = toggleAllShown(shown, new Set(["d"]), true);
    expect([...next].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("unticks only the shown rows", () => {
    const next = toggleAllShown(shown, new Set(["a", "b", "d"]), false);
    expect([...next]).toEqual(["d"]);
  });

  it("does not change the set it was given", () => {
    const picked = new Set(["a"]);
    toggleAllShown(shown, picked, true);
    expect([...picked]).toEqual(["a"]);
  });
});

describe("pruneSelection", () => {
  it("drops ids that left the record, e.g. after a delete", () => {
    expect([...pruneSelection(new Set(["a", "gone", "c"]), rows)]).toEqual(["a", "c"]);
  });
});
