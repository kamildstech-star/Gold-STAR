import { describe, expect, it } from "vitest";

import {
  buildDocumentFolderTree,
  documentFolderCounts,
  documentsInFolder,
  flattenDocumentFolderTree,
  type DocumentFolder,
} from "./documents";

/**
 * David, on the call: "you have it in folders, but … I can't even create new
 * documents over here. It's not letting me create new documents, new folders."
 *
 * The Documents page now carries the same rail the job and account panels do,
 * which means one more caller depends on what "in this folder" means. These
 * are the rules both surfaces read from, pinned once: a folder view is
 * inclusive of everything beneath it, and no selection is not an empty view.
 */
function folder(id: string, name: string, parent: string | null = null): DocumentFolder {
  return {
    id,
    location_id: "loc-1",
    job_id: null,
    account_id: null,
    project_id: null,
    name,
    parent_folder_id: parent,
    sort_order: 0,
    created_at: "2026-09-01T00:00:00Z",
  };
}

const FOLDERS = [
  folder("carrier", "Carrier correspondence"),
  folder("denials", "Denials", "carrier"),
  folder("appeals", "Appeals", "denials"),
  folder("w9", "W-9s"),
];

const ROWS = [
  { id: "a", folder_id: null },
  { id: "b", folder_id: "carrier" },
  { id: "c", folder_id: "denials" },
  { id: "d", folder_id: "appeals" },
  { id: "e", folder_id: "w9" },
];

describe("documentsInFolder", () => {
  it("shows everything when no folder is selected", () => {
    expect(documentsInFolder(ROWS, FOLDERS, null).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("shows everything when the folders migration is missing", () => {
    // `null` folders is "this database has no folders", never "no documents".
    expect(documentsInFolder(ROWS, null, "carrier")).toHaveLength(ROWS.length);
  });

  it("includes documents filed in subfolders, however deep", () => {
    expect(documentsInFolder(ROWS, FOLDERS, "carrier").map((r) => r.id)).toEqual(["b", "c", "d"]);
    expect(documentsInFolder(ROWS, FOLDERS, "denials").map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("never leaks a sibling folder's documents", () => {
    expect(documentsInFolder(ROWS, FOLDERS, "w9").map((r) => r.id)).toEqual(["e"]);
  });

  it("leaves top-level documents out of every folder", () => {
    const everyFolder = FOLDERS.flatMap((f) => documentsInFolder(ROWS, FOLDERS, f.id));
    expect(everyFolder.some((r) => r.id === "a")).toBe(false);
  });

  it("does not mutate or alias the row list it was given", () => {
    const out = documentsInFolder(ROWS, FOLDERS, null);
    out.pop();
    expect(ROWS).toHaveLength(5);
  });
});

describe("documentFolderCounts", () => {
  it("counts what is filed directly in each folder", () => {
    // The rail's number is what is in that folder, not the subtree — the
    // subtree is what clicking it shows.
    expect(documentFolderCounts(ROWS)).toEqual({ carrier: 1, denials: 1, appeals: 1, w9: 1 });
  });

  it("ignores documents at the top level", () => {
    expect(documentFolderCounts([{ folder_id: null }])).toEqual({});
  });
});

describe("the rail's flattened tree", () => {
  it("orders parents before their children and stamps the indent", () => {
    const nodes = flattenDocumentFolderTree(buildDocumentFolderTree(FOLDERS));
    expect(nodes.map((n) => [n.id, n.depth])).toEqual([
      ["carrier", 0],
      ["denials", 1],
      ["appeals", 2],
      ["w9", 0],
    ]);
  });
});
