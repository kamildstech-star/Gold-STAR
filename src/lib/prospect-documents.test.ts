import { describe, expect, it } from "vitest";

import {
  RECENT_DOCUMENT_ROWS,
  documentCountLabel,
  hiddenDocumentsLabel,
  recentDocuments,
} from "./prospect-documents";

const doc = (id: string, created_at: string | null) => ({ id, created_at });

describe("recentDocuments", () => {
  it("returns the newest rows first, capped at the section's row count", () => {
    const rows = [
      doc("old", "2026-08-01T10:00:00Z"),
      doc("newest", "2026-09-08T10:00:00Z"),
      doc("mid", "2026-08-20T10:00:00Z"),
      doc("older", "2026-07-01T10:00:00Z"),
    ];
    expect(recentDocuments(rows).map((r) => r.id)).toEqual(["newest", "mid", "old"]);
    expect(RECENT_DOCUMENT_ROWS).toBe(3);
  });

  it("honors an explicit limit and an empty list", () => {
    const rows = [doc("a", "2026-09-01T10:00:00Z"), doc("b", "2026-09-02T10:00:00Z")];
    expect(recentDocuments(rows, 1).map((r) => r.id)).toEqual(["b"]);
    expect(recentDocuments(rows, 0)).toEqual([]);
    expect(recentDocuments([])).toEqual([]);
  });

  it("keeps rows with no stamp at the end and preserves order between equal stamps", () => {
    const rows = [
      doc("unstamped", null),
      doc("first", "2026-09-01T10:00:00Z"),
      doc("second", "2026-09-01T10:00:00Z"),
      doc("corrupt", "not a date"),
    ];
    expect(recentDocuments(rows, 4).map((r) => r.id)).toEqual([
      "first",
      "second",
      "unstamped",
      "corrupt",
    ]);
  });

  it("does not mutate the list it was given", () => {
    const rows = [doc("a", "2026-09-01T10:00:00Z"), doc("b", "2026-09-02T10:00:00Z")];
    recentDocuments(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("documentCountLabel", () => {
  it("pluralises and names the empty case", () => {
    expect(documentCountLabel(0)).toBe("No documents");
    expect(documentCountLabel(1)).toBe("1 document");
    expect(documentCountLabel(4)).toBe("4 documents");
  });
});

describe("hiddenDocumentsLabel", () => {
  it("says how many rows are behind All documents, and nothing when none are", () => {
    expect(hiddenDocumentsLabel(5, 3)).toBe("2 more");
    expect(hiddenDocumentsLabel(3, 3)).toBeNull();
    expect(hiddenDocumentsLabel(2, 3)).toBeNull();
    expect(hiddenDocumentsLabel(0, 0)).toBeNull();
  });
});
