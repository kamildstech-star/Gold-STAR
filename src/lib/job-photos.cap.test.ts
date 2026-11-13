/**
 * The job album stopped at 600 photos and 200 documents and said nothing —
 * `.limit(600)` and `.limit(200)` on the one read every caller shared. These
 * tests are here so a silent ceiling cannot come back, and so each caller says
 * how much it wants instead of inheriting someone else's cap.
 *
 * No DOM library in this repo, so the wiring is checked by reading the source
 * and asserting on regex-extracted fragments, never on the whole file — an
 * explanatory comment must not be able to satisfy or break an assertion.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GRID_PAGE, PAGE_CEILING, STRIP_PAGE } from "./job-photos";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
/** Comments out, so prose about the old cap is not mistaken for a cap. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const LIB = read("src/lib/job-photos.ts");
const LIB_CODE = code(LIB);

/** The body of one top-level function in job-photos.ts, by name. */
function fn(name: string): string {
  const start = LIB_CODE.search(new RegExp(`(?:export )?(?:async )?function ${name}\\b`));
  expect(start, `${name} exists`).toBeGreaterThan(-1);
  const next = LIB_CODE.slice(start + 1).search(
    /\n(?:export )?(?:async )?function |\nexport const |\nconst /,
  );
  return next < 0 ? LIB_CODE.slice(start) : LIB_CODE.slice(start, start + 1 + next);
}

describe("job-photos.ts has no silent ceiling on the album", () => {
  /*
   * A number written straight into `.limit(` is how the cap got in. The only
   * literals allowed are on reads that are not the album, each with its reason:
   */
  const ALLOWED_LITERAL_LIMITS: Record<string, string> = {
    // One annotation row per photo; the newest-first .limit(1) picks it.
    loadPhotoAnnotation: "1",
    // Tag-name lookup: up to 20 near-matches are compared exactly in memory.
    findTagByName: "20",
  };

  it("writes no numeric .limit() anywhere but the allowlisted non-album reads", () => {
    const literal = [...LIB_CODE.matchAll(/\.limit\(\s*(\d+)\s*\)/g)];
    const found: Record<string, string> = {};
    for (const m of literal) {
      const before = LIB_CODE.slice(0, m.index);
      const owner = [...before.matchAll(/function (\w+)/g)].pop()?.[1] ?? "?";
      found[owner] = m[1]!;
    }
    expect(found).toEqual(ALLOWED_LITERAL_LIMITS);
    // And the two numbers that were the bug are nowhere at all.
    expect(LIB_CODE).not.toMatch(/\.limit\(\s*600\s*\)/);
    expect(LIB_CODE).not.toMatch(/\.limit\(\s*200\s*\)/);
  });

  it("sizes every album and document page through the named, clamped page size", () => {
    for (const name of ["loadAlbumPage", "loadDocumentPage"]) {
      const body = fn(name);
      expect(body).toContain("const size = clampPage(limit);");
      expect(body.match(/\.limit\(([^)]*)\)/)![1]).toBe("size + 1");
    }
    // PostgREST answers at most 1000 rows and truncates silently past that, so
    // a page plus its look-ahead row has to fit under it.
    expect(PAGE_CEILING + 1).toBeLessThanOrEqual(1000);
    expect(GRID_PAGE).toBeLessThanOrEqual(PAGE_CEILING);
    expect(STRIP_PAGE).toBeLessThanOrEqual(PAGE_CEILING);
  });

  it("orders album pages totally, so a cursor is never ambiguous", () => {
    const orders = [...fn("loadAlbumPage").matchAll(/\.order\("(\w+)"/g)].map((m) => m[1]);
    expect(orders).toEqual(["captured_at", "created_at", "id"]);
    const docOrders = [...fn("loadDocumentPage").matchAll(/\.order\("(\w+)"/g)].map((m) => m[1]);
    expect(docOrders).toEqual(["created_at", "id"]);
  });

  it("reads the whole job, for the pickers, by looping pages until there is no cursor", () => {
    const body = fn("loadAllJobPhotos");
    expect(body).toMatch(/while \(albumCursor\)/);
    expect(body).toMatch(/while \(docCursor\)/);
  });

  it("counts through the database, falling back to head counts, never to an array length", () => {
    const body = fn("loadJobPhotoTally");
    expect(body).toContain('"job_photo_day_counts"');
    expect(body).toMatch(/count: "exact", head: true/);
    // "Does the job have an album at all" is the only length it may ask.
    expect(body.replace(/ctx\.albumIds\.length/g, "")).not.toMatch(/\.length/);
  });
});

/** Every .ts/.tsx under src, for the "nobody calls the old loader" check. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("each caller says how many photos it wants", () => {
  it("nothing calls the old one-size loader", () => {
    const callers = sources("src").filter((p) => /\bloadJobPhotos\s*\(/.test(code(read(p))));
    expect(callers).toEqual([]);
  });

  it("an invoice and every report resolve exactly the ids they name", () => {
    const fnBody = code(read("src/lib/invoice-photos.ts")).match(
      /export async function loadInvoicePhotos[\s\S]*?\n}/,
    )![0];
    expect(fnBody).toContain("loadJobPhotosByIds(jobId, ids)");
  });

  it("the invoice card resolves its attached ids, and reads the whole job only for its picker", () => {
    const src = code(read("src/components/invoice-photos.tsx"));
    const attached = src.match(/const photosQ = useQuery\(\{[\s\S]*?\}\);/)![0];
    expect(attached).toContain("loadJobPhotosByIds(jobId!, ids)");
    const picker = src.match(/const pickerQ = useQuery\(\{[\s\S]*?\}\);/)![0];
    expect(picker).toContain("loadAllJobPhotos(jobId!)");
    expect(picker).toContain("pickerOpen");
  });

  it("the report picker reads the whole job, once it is opened", () => {
    const q = code(read("src/components/job-report-panel.tsx")).match(
      /const photosQ = useQuery\(\{[\s\S]*?\}\);/,
    )![0];
    expect(q).toContain("loadAllJobPhotos(jobId)");
    expect(q).toContain("pickerOpen");
  });

  it("the report snapshot counts photos in the database, not by reading rows back", () => {
    const src = code(read("src/lib/job-reports.server.ts"));
    const block = src.slice(src.indexOf("let photoCount = 0;"), src.indexOf("const fieldForms"));
    expect(block).toMatch(/count: "exact", head: true/);
    expect(block).not.toMatch(/photoCount = \(photos \?\? \[\]\)\.length/);
  });
});

describe("the Pictures tab's numbers are the database's", () => {
  const UI = read("src/components/job-photos.tsx");
  const PAGE = read("src/routes/_authenticated/jobs.$id.tsx");

  it("the tab badge is the job's total, not the length of a loaded list", () => {
    // A literal Pictures trigger, or the one trigger the role-ordered strip
    // maps every tab through (#282) — the badge is in whichever exists.
    const trigger =
      PAGE.match(/<TabsTrigger value="pictures">[\s\S]*?<\/TabsTrigger>/)?.[0] ??
      PAGE.match(/<TabsTrigger key=\{t\} value=\{t\}>[\s\S]*?<\/TabsTrigger>/)?.[0] ??
      // 3 Nov: the strip computes each tab's count above its trigger.
      PAGE.match(/\{tabOrder\.map\(\(t\) => \{[\s\S]*?<\/TabsTrigger>/)?.[0];
    expect(trigger, "the Pictures tab trigger was not found").toBeTruthy();
    expect(trigger).toContain("jobPhotos.tally?.total");
    expect(trigger).not.toMatch(/photos\.length/);
  });

  it("All photos in the folder rail, and each folder, come from the tally", () => {
    expect(UI.match(/rootCount=\{[^}]*\}/)![0]).toBe("rootCount={total}");
    const counts = UI.match(/const folderCounts = useMemo\([^;]*;/)![0];
    expect(counts).toContain("tally?.byFolder");
  });

  it("the upload notice compares against the database's album count", () => {
    const notice = UI.match(/<PendingUploadsNotice[^>]*\/>/)![0];
    expect(notice).toContain("landed={tally.albumTotal}");
  });

  it("each room's badge and each day's count are reconciled, not counted off the tiles", () => {
    const room = UI.slice(UI.indexOf("shown.map(({ room, key, page, head, rows })"));
    expect(room.match(/<Badge variant="secondary">\{([^}]*)\}<\/Badge>/)![1]).toBe("head.count");
    const dayHeader = room.match(
      /className="flex items-baseline justify-between[^"]*"[\s\S]*?<\/div>/,
    )![0];
    expect(dayHeader).toContain("{countText(day)}");
    expect(dayHeader).not.toContain("photos.length");
  });

  it("a room that has more shows how much and loads the rest as it scrolls", () => {
    const more = UI.match(/function RoomMore\([\s\S]*?\n}\n/)![0];
    expect(more).toContain("IntersectionObserver");
    expect(more).toMatch(/Showing \{loaded\} of \{total\}/);
    // The button stays: without IntersectionObserver it is the only way on.
    expect(more).toContain("onClick={onMore}");
  });

  it("Select all on a room still paging reads the rest of the room first", () => {
    const select = UI.match(/const selectRoom = useCallback\([\s\S]*?\n {2}\);?\n/)![0];
    expect(select).toContain("await loadRest(key)");
  });

  it("the strip previews the newest page explicitly and says the job's real total", () => {
    const strip = UI.slice(UI.indexOf("export function JobPhotoStrip("));
    expect(strip).toContain("useNewestPhotos(album)");
    expect(strip.match(/View all \{(\w+)\}/)![1]).toBe("total");
  });

  it("the viewer holds the open photo by id, so pages landing cannot swap it", () => {
    const grid = UI.slice(UI.indexOf("export function JobPhotos("));
    expect(grid).toMatch(/onIndex=\{\(i\) => setOpenId\(flat\[i\]\?\.id \?\? null\)\}/);
  });
});
