import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  GONE_REASON,
  NOT_MANAGER_REASON,
  deleteDocuments,
  deleteSummary,
  partitionForDelete,
  storageObjectsOf,
  type DeleteCandidate,
} from "./document-delete";

const doc = (id: string, over: Partial<DeleteCandidate> = {}): DeleteCandidate => ({
  id,
  name: `${id}.pdf`,
  status: "active",
  location_id: "loc-1",
  storage_bucket: "documents",
  storage_path: `loc-1/job-1/${id}.pdf`,
  ...over,
});

describe("partitionForDelete", () => {
  it("keeps signed documents out of the delete, in order", () => {
    const rows = [
      doc("a"),
      doc("b", { status: "signed" }),
      doc("c", { status: "sent" }),
      doc("d", { status: "signed" }),
    ];
    const { deletable, signed } = partitionForDelete(rows);
    expect(deletable.map((d) => d.id)).toEqual(["a", "c"]);
    expect(signed.map((d) => d.id)).toEqual(["b", "d"]);
  });

  it("handles nothing selected", () => {
    expect(partitionForDelete([])).toEqual({ deletable: [], signed: [] });
  });
});

describe("storageObjectsOf", () => {
  it("names the file, the thumbnail and every listed sidecar", () => {
    expect(storageObjectsOf(doc("a"), ["thumb.webp", "signature.png"])).toEqual({
      bucket: "documents",
      paths: ["loc-1/job-1/a.pdf", "a/thumb.webp", "a/signature.png"],
    });
  });

  it("falls back to the documents bucket and skips a missing file path", () => {
    expect(storageObjectsOf(doc("a", { storage_bucket: null, storage_path: null }))).toEqual({
      bucket: "documents",
      paths: ["a/thumb.webp"],
    });
  });

  it("leaves a file another document still points at", () => {
    const out = storageObjectsOf(doc("a"), [], new Set(["loc-1/job-1/a.pdf"]));
    expect(out.paths).toEqual(["a/thumb.webp"]);
  });
});

describe("deleteSummary", () => {
  const empty = { deleted: [], signed: [], failed: [], fileLeftovers: [] };

  it("is a plain success when everything went", () => {
    expect(deleteSummary({ ...empty, deleted: [{ id: "a", name: "a.pdf" }] })).toEqual({
      tone: "success",
      title: "1 document deleted",
      description: undefined,
    });
  });

  it("says signed ones were kept and names each failure with its reason", () => {
    const s = deleteSummary({
      ...empty,
      deleted: [
        { id: "a", name: "a.pdf" },
        { id: "b", name: "b.png" },
      ],
      signed: [{ id: "c", name: "WA.pdf" }],
      failed: [{ id: "d", name: "d.pdf", reason: NOT_MANAGER_REASON }],
    });
    expect(s.tone).toBe("warning");
    expect(s.title).toBe("2 documents deleted, 1 not");
    expect(s.description).toContain("1 signed document kept");
    expect(s.description).toContain(`d.pdf: ${NOT_MANAGER_REASON}`);
  });

  it("is an error when nothing could be deleted", () => {
    const s = deleteSummary({ ...empty, failed: [{ id: "d", name: "d.pdf", reason: "x" }] });
    expect(s.tone).toBe("error");
    expect(s.title).toBe("Could not delete 1 document");
  });

  it("is a warning, not an error, when only signed ones were picked", () => {
    const s = deleteSummary({ ...empty, signed: [{ id: "c", name: "WA.pdf" }] }, "picture");
    expect(s).toMatchObject({ tone: "warning", title: "Nothing deleted" });
    expect(s.description).toContain("1 signed picture kept");
  });
});

/* A stand-in for the supabase client: just the calls deleteDocuments makes, logged in order. */
function fakeDb(opts: {
  rows: DeleteCandidate[];
  manages?: Record<string, boolean>;
  refuseDelete?: string[];
  removeError?: boolean;
}) {
  const log: string[] = [];
  const db = {
    rpc: vi.fn(async (_fn: string, args: { _location_id: string }) => ({
      data: opts.manages?.[args._location_id] ?? true,
      error: null,
    })),
    from: vi.fn(() => {
      let deleting = false;
      const q = {
        select: () => q,
        delete: () => {
          deleting = true;
          return q;
        },
        in: async (col: string, vals: string[]) => ({
          data: opts.rows.filter((r) =>
            vals.includes(col === "id" ? r.id : (r.storage_path ?? "")),
          ),
          error: null,
        }),
        eq: (_c: string, id: string) => {
          if (deleting) log.push(`row:${id}`);
          return {
            select: async () => ({
              data: opts.refuseDelete?.includes(id) ? [] : [{ id }],
              error: null,
            }),
          };
        },
      };
      return q;
    }),
    storage: {
      from: () => ({
        list: async (prefix: string) => ({ data: [{ name: "thumb.webp" }], error: null, prefix }),
        remove: async (paths: string[]) => {
          log.push(`files:${paths.join(",")}`);
          return { data: [], error: opts.removeError ? { message: "nope" } : null };
        },
      }),
    },
  };
  return { db: db as never, log };
}

describe("deleteDocuments", () => {
  it("removes each document's files while its row still grants them, then the row", async () => {
    const { db, log } = fakeDb({ rows: [doc("a"), doc("b", { status: "signed" })] });
    const r = await deleteDocuments(["a", "b", "gone"], { userId: "u1" }, db);
    expect(log).toEqual(["files:loc-1/job-1/a.pdf,a/thumb.webp", "row:a"]);
    expect(r.deleted).toEqual([{ id: "a", name: "a.pdf" }]);
    expect(r.signed).toEqual([{ id: "b", name: "b.pdf" }]);
    expect(r.failed).toEqual([{ id: "gone", name: "A document", reason: GONE_REASON }]);
  });

  it("touches nothing in an office the person does not manage", async () => {
    const { db, log } = fakeDb({
      rows: [doc("a"), doc("x", { location_id: "loc-2" })],
      manages: { "loc-2": false },
    });
    const r = await deleteDocuments(["a", "x"], { userId: "u1" }, db);
    expect(log.some((l) => l.includes("x"))).toBe(false);
    expect(r.failed).toEqual([{ id: "x", name: "x.pdf", reason: NOT_MANAGER_REASON }]);
  });

  it("names a row the database refused, and says its file already went", async () => {
    const { db } = fakeDb({ rows: [doc("a")], refuseDelete: ["a"] });
    const r = await deleteDocuments(["a"], { userId: "u1" }, db);
    expect(r.deleted).toEqual([]);
    expect(r.failed[0].reason).toMatch(/Delete it again/);
  });

  it("still deletes the row when its files could not be removed, and says so", async () => {
    const { db } = fakeDb({ rows: [doc("a")], removeError: true });
    const r = await deleteDocuments(["a"], { userId: "u1" }, db);
    expect(r.deleted).toEqual([{ id: "a", name: "a.pdf" }]);
    expect(r.fileLeftovers).toEqual([{ id: "a", name: "a.pdf" }]);
  });

  it("does nothing without a signed-in user", async () => {
    const { db, log } = fakeDb({ rows: [doc("a")] });
    const r = await deleteDocuments(["a"], { userId: null }, db);
    expect(log).toEqual([]);
    expect(r.failed).toHaveLength(1);
  });
});
