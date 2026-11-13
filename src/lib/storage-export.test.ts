// TODO(remove after cutover): goes with storage-export.ts.
import { describe, expect, it, vi } from "vitest";

import {
  LIST_PAGE_SIZE,
  MANIFEST_HEADERS,
  MANIFEST_LINK_SECONDS,
  SIGN_BATCH_SIZE,
  SUMMARY_MARKER,
  bucketTotals,
  buildManifestCsv,
  chunk,
  listAllObjects,
  listBucketObjects,
  signObjects,
  type ManifestStorage,
} from "./storage-export";

type Fake = {
  storage: ManifestStorage;
  signCalls: { bucket: string; paths: string[]; seconds: number }[];
  v2Calls: number;
  v1Calls: number;
};

/**
 * A Storage server in memory. `mode` decides how list-v2 behaves:
 *  - "flat": honours with_delimiter:false (today's Supabase)
 *  - "grouped": ignores it and answers one level at a time, folders apart
 *  - "missing": list-v2 not implemented, so the classic walk must run
 */
function fakeStorage(
  buckets: Record<string, string[]>,
  mode: "flat" | "grouped" | "missing" = "flat",
  opts: { unsignable?: string[]; pageSize?: number } = {},
): Fake {
  const pageSize = opts.pageSize ?? LIST_PAGE_SIZE;
  const fake: Fake = { signCalls: [], v2Calls: 0, v1Calls: 0, storage: null as never };
  const meta = (p: string) => ({ size: p.length * 10, mimetype: "image/jpeg" });

  fake.storage = {
    listBuckets: async () => ({
      data: Object.keys(buckets).map((id) => ({ id, name: id })),
      error: null,
    }),
    from: (bucket) => {
      const all = [...(buckets[bucket] ?? [])].sort();
      return {
        listV2: async ({ prefix = "", cursor, limit = 1000, with_delimiter }) => {
          fake.v2Calls += 1;
          if (mode === "missing") return { data: null, error: { message: "Route not found" } };
          const start = cursor ? Number(cursor) : 0;
          const under = all.filter((p) => p.startsWith(prefix));
          if (mode === "flat" && with_delimiter === false) {
            const page = under.slice(start, start + Math.min(limit, pageSize));
            const next = start + page.length;
            return {
              data: {
                hasNext: next < under.length,
                nextCursor: next < under.length ? String(next) : undefined,
                folders: [],
                objects: page.map((p) => ({
                  name: p,
                  key: p,
                  updated_at: "2026-10-01T00:00:00Z",
                  metadata: meta(p),
                })),
              },
              error: null,
            };
          }
          // Grouped: direct children only, folder names relative, no `key`.
          const rest = under.map((p) => p.slice(prefix.length));
          const files = rest.filter((r) => !r.includes("/"));
          const folders = [
            ...new Set(rest.filter((r) => r.includes("/")).map((r) => r.split("/")[0] + "/")),
          ];
          return {
            data: {
              hasNext: false,
              folders: folders.map((name) => ({ name })),
              objects: files.map((name) => ({
                name,
                updated_at: null,
                metadata: meta(prefix + name),
              })),
            },
            error: null,
          };
        },
        list: async (path = "", o = {}) => {
          fake.v1Calls += 1;
          const prefix = path ? `${path}/` : "";
          const rest = all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
          const entries = [
            ...[...new Set(rest.filter((r) => r.includes("/")).map((r) => r.split("/")[0]!))].map(
              (name) => ({ name, id: null }),
            ),
            ...rest
              .filter((r) => !r.includes("/"))
              .map((name) => ({
                name,
                id: `id-${prefix}${name}`,
                updated_at: null,
                metadata: meta(prefix + name),
              })),
          ].sort((a, b) => a.name.localeCompare(b.name));
          const offset = o.offset ?? 0;
          return {
            data: entries.slice(offset, offset + Math.min(o.limit ?? 100, pageSize)),
            error: null,
          };
        },
        createSignedUrls: async (paths, seconds) => {
          fake.signCalls.push({ bucket, paths, seconds });
          return {
            data: paths.map((p) => ({
              path: p,
              signedUrl: opts.unsignable?.includes(p)
                ? null
                : `https://x.supabase.co/sign/${bucket}/${p}?token=t`,
              error: opts.unsignable?.includes(p) ? "Object not found" : null,
            })),
            error: null,
          };
        },
      };
    },
  };
  return fake;
}

const NESTED = [
  "job-1/a.jpg",
  "job-1/thumbs/a.jpg",
  "job-1/rooms/kitchen/b.jpg",
  "job-2/c.jpg",
  "top.jpg",
  "job-3/.emptyFolderPlaceholder",
];

describe("listing finds every object, nested paths included", () => {
  it.each(["flat", "grouped", "missing"] as const)("list-v2 %s", async (mode) => {
    const fake = fakeStorage({ "project-photos": NESTED }, mode);
    const objects = await listBucketObjects(fake.storage, "project-photos");
    expect(objects.map((o) => o.path)).toEqual([...NESTED].sort());
    expect(objects.every((o) => o.bucket === "project-photos")).toBe(true);
  });

  it("the flat listing is one call per thousand objects, with no folder walk", async () => {
    const paths = Array.from({ length: 2500 }, (_, i) => `job-${i % 40}/deep/${i}.jpg`);
    const fake = fakeStorage({ b: paths }, "flat");
    const objects = await listBucketObjects(fake.storage, "b");
    expect(objects).toHaveLength(2500);
    expect(fake.v2Calls).toBe(3);
    expect(fake.v1Calls).toBe(0);
  });

  it("list-v2 follows the cursor, whatever page size the server picks", async () => {
    const paths = Array.from({ length: 23 }, (_, i) => `f/${String(i).padStart(2, "0")}.jpg`);
    const fake = fakeStorage({ b: paths }, "flat", { pageSize: 5 });
    const objects = await listBucketObjects(fake.storage, "b");
    expect(objects.map((o) => o.path)).toEqual(paths);
    expect(fake.v2Calls).toBe(5);
  });

  it("the folder walk pages by offset past a thousand entries in one folder", async () => {
    const paths = Array.from({ length: 2100 }, (_, i) => `f/${String(i).padStart(4, "0")}.jpg`);
    const fake = fakeStorage({ b: paths }, "missing");
    const objects = await listBucketObjects(fake.storage, "b");
    expect(objects.map((o) => o.path)).toEqual(paths);
    // root, then f/ three times (1000 + 1000 + 100)
    expect(fake.v1Calls).toBe(4);
  });

  it("falls back to the folder walk only when list-v2 is refused", async () => {
    const fake = fakeStorage({ b: NESTED }, "missing");
    await listBucketObjects(fake.storage, "b");
    expect(fake.v2Calls).toBe(1);
    expect(fake.v1Calls).toBeGreaterThan(1);
  });

  it("every bucket is listed, empty ones included, and a bucket that cannot be listed fails the run", async () => {
    const fake = fakeStorage({
      documents: ["x.pdf"],
      "chat-attachments": [],
      "project-photos": NESTED,
    });
    const { buckets, objects } = await listAllObjects(fake.storage);
    expect(buckets).toEqual(["chat-attachments", "documents", "project-photos"]);
    expect(objects).toHaveLength(NESTED.length + 1);

    const broken: ManifestStorage = {
      ...fake.storage,
      from: () => ({
        listV2: async () => ({ data: null, error: { message: "nope" } }),
        list: async () => ({ data: null, error: { message: "denied" } }),
        createSignedUrls: async () => ({ data: null, error: { message: "x" } }),
      }),
    };
    await expect(listAllObjects(broken)).rejects.toThrow(/Could not list bucket .*denied/);
  });
});

describe("signing", () => {
  it("signs 100 paths per call, per bucket, for 24 hours", async () => {
    const photos = Array.from({ length: 707 }, (_, i) => `job/${i}.jpg`);
    const docs = Array.from({ length: 22 }, (_, i) => `d/${i}.pdf`);
    const fake = fakeStorage({ "project-photos": photos, documents: docs });
    const { objects } = await listAllObjects(fake.storage);
    const signed = await signObjects(fake.storage, objects);

    expect(signed).toHaveLength(729);
    expect(signed.every((o) => o.signedUrl?.startsWith("https://"))).toBe(true);
    expect(fake.signCalls.map((c) => c.paths.length)).toEqual([
      22, 100, 100, 100, 100, 100, 100, 100, 7,
    ]);
    expect(fake.signCalls.every((c) => c.paths.length <= SIGN_BATCH_SIZE)).toBe(true);
    expect(new Set(fake.signCalls.map((c) => c.seconds))).toEqual(new Set([MANIFEST_LINK_SECONDS]));
    expect(MANIFEST_LINK_SECONDS).toBe(86_400);
  });

  it("an object Storage will not sign keeps its row, with no link, and is counted", async () => {
    const fake = fakeStorage({ b: ["a.jpg", "gone.jpg"] }, "flat", { unsignable: ["gone.jpg"] });
    const { buckets, objects } = await listAllObjects(fake.storage);
    const signed = await signObjects(fake.storage, objects);
    expect(signed.find((o) => o.path === "gone.jpg")?.signedUrl).toBeNull();
    expect(bucketTotals(buckets, signed)[0]).toMatchObject({ objects: 2, unsigned: 1 });
  });

  it("a refused batch fails the run rather than leaving files out", async () => {
    const storage = {
      from: () => ({
        createSignedUrls: vi.fn(async () => ({ data: null, error: { message: "boom" } })),
      }),
    } as never;
    await expect(
      signObjects(storage, [
        { bucket: "b", path: "a", size: 1, contentType: null, updatedAt: null },
      ]),
    ).rejects.toThrow("Could not sign files in b: boom");
  });

  it("chunk splits without dropping or repeating", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
  });
});

describe("the CSV", () => {
  const generatedAt = new Date("2026-10-12T09:00:00Z");

  it("has the agreed header, one row per object, then a summary per bucket and for ALL", async () => {
    const fake = fakeStorage({
      "project-photos": ["j/a.jpg", "j/b.jpg"],
      documents: ['odd, "name".pdf'],
      empty: [],
    });
    const { buckets, objects } = await listAllObjects(fake.storage);
    const signed = await signObjects(fake.storage, objects);
    const totals = bucketTotals(buckets, signed);
    const lines = buildManifestCsv(signed, totals, generatedAt).split("\n");

    expect(lines[0]).toBe(MANIFEST_HEADERS.join(","));
    expect(lines[0]).toBe("bucket,path,size,content_type,updated_at,signed_url");
    // Paths are written exactly as stored; CSV quoting only where needed.
    expect(lines).toContain(
      `documents,"odd, ""name"".pdf",150,image/jpeg,2026-10-01T00:00:00Z,"https://x.supabase.co/sign/documents/odd, ""name"".pdf?token=t"`,
    );
    expect(lines.filter((l) => l.startsWith("project-photos,"))).toHaveLength(2);

    const summary = lines.filter((l) => l.startsWith(`${SUMMARY_MARKER},`));
    expect(summary).toEqual([
      `${SUMMARY_MARKER},project-photos,140,2 objects,2026-10-12T09:00:00.000Z,`,
      `${SUMMARY_MARKER},documents,150,1 objects,2026-10-12T09:00:00.000Z,`,
      `${SUMMARY_MARKER},empty,0,0 objects,2026-10-12T09:00:00.000Z,`,
      `${SUMMARY_MARKER},ALL,290,3 objects,2026-10-12T09:00:00.000Z,`,
    ]);
    // Six columns on every line a script reads.
    expect(lines.filter((l) => !l.includes('"')).every((l) => l.split(",").length === 6)).toBe(
      true,
    );
  });

  it("the unsigned count shows on the summary", () => {
    const csv = buildManifestCsv(
      [{ bucket: "b", path: "x", size: 5, contentType: null, updatedAt: null, signedUrl: null }],
      [{ bucket: "b", objects: 1, bytes: 5, unsigned: 1 }],
      generatedAt,
    );
    expect(csv).toContain("b,x,5,,,\n");
    expect(csv).toContain(`${SUMMARY_MARKER},b,5,1 objects,2026-10-12T09:00:00.000Z,1 unsigned`);
  });
});
