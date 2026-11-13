import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-10-05, on a job's drying log:
 *
 *   "humidity is missing and we need the outisde information to automatically
 *    be inputted"
 *   "for the temp readings, everything need to be labeled in the box"
 *
 * The figures and their labels are computed by tileFigures in
 * src/lib/drying-day-grid.ts and tested there. What has to hold HERE is that
 * the square draws every one of them with its label inside the box, that
 * nothing it shows can be clipped, that the page fills its own outside days,
 * and that the nightly hook says why a fetch failed instead of counting it.
 *
 * Fragments are extracted with a regex before asserting, never the whole file,
 * so an explanatory comment can neither satisfy nor break a check. Line
 * endings are normalised because git checks this repo out CRLF on Windows and
 * an agent worktree may hold LF.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LOG = read("src/components/job-drying-log.tsx");
const HOOK = read("src/routes/api/public/hooks/drying-weather.ts");
const NIGHTLY = read("src/lib/outside-conditions-nightly.server.ts");

/** The DayTile component's returned markup: from its <button to its </button>. */
const DAY_TILE = (() => {
  const fn = LOG.slice(LOG.indexOf("function DayTile({"));
  return fn.slice(fn.indexOf("  return (\n    <button"), fn.indexOf("    </button>") + 13);
})();

/** Every `{…}` expression the tile renders as text, i.e. not inside an attribute. */
const RENDERED = [...DAY_TILE.matchAll(/>\s*\{([^{}]+)\}\s*</g)].map((m) => m[1]!.trim());

describe("every figure on the square is labeled inside the box", () => {
  it("draws the Out / In headings and a label on every Temp / RH / Dew row", () => {
    expect(RENDERED).toContain("figures.out.heading");
    expect(RENDERED).toContain("figures.in.heading");
    expect(RENDERED).toContain("row.label");
    // The two figures of each row are drawn from the same row as its label.
    expect(RENDERED).toContain("row.out");
    expect(RENDERED).toContain("row.in");
    expect(DAY_TILE).toMatch(/figures\.rows\.map\(\(row, i\)/);
  });

  it("labels the affected figure, the baseline delta and the materials count", () => {
    expect(RENDERED).toContain("figures.affected.label");
    expect(RENDERED).toContain("figures.affected.value");
    expect(RENDERED).toContain("figures.insideVsBaseline.label");
    expect(RENDERED).toContain("figures.insideVsBaseline.value");
    expect(DAY_TILE).toMatch(/>Materials dry</);
  });

  it("prints no tile figure straight off the tile — only through a labeled figure", () => {
    // A raw `{tile.outsideDewPoint}` in the markup is how a bare "55.9°" got
    // on the square in the first place. Every number now arrives via
    // tileFigures, which pairs it with a label; the date is the only tile
    // field drawn directly, and it is not a reading.
    const raw = RENDERED.filter((e) => /\btile\.\w+/.test(e) && !/shortDate\(tile\.date\)/.test(e));
    expect(raw).toEqual([]);
    expect(DAY_TILE).not.toMatch(/°\s*<span[^>]*>\s*dew/);
  });

  it("puts nothing only on hover: the title text carries no figure the box lacks", () => {
    // The title/aria sentence is built from the same cells; it must not be
    // the only place a value appears. Temperature was, until this change.
    const fn = LOG.slice(LOG.indexOf("function DayTile({"));
    const detail = fn.slice(fn.indexOf("const detail = ["), fn.indexOf('.join(", ")'));
    for (const f of ["outsideTempF", "insideTempF", "outsideRh", "insideRh"]) {
      expect(detail).not.toContain(f);
    }
  });

  it("clips nothing: no truncate anywhere on the square, and every line nowraps", () => {
    // The strip was cutting "in n…" before any of this. A number that is cut
    // off is not on the screen.
    expect(DAY_TILE).not.toMatch(/\btruncate\b/);
    const grid = DAY_TILE.match(/<span className="grid grid-cols-\[auto_1fr_1fr\][^"]*"/);
    expect(grid).not.toBeNull();
    expect(grid![0]).toContain("whitespace-nowrap");
  });

  it("keeps the out/in comparison on one line per quantity, Dew drawn stronger", () => {
    // Columns Out and In, so each row reads outside-against-inside.
    expect(DAY_TILE).toMatch(/"col-start-2 text-right font-medium">\{figures\.out\.heading\}/);
    expect(DAY_TILE).toMatch(/"col-start-3 text-right font-medium">\{figures\.in\.heading\}/);
    expect(DAY_TILE).toMatch(/row\.compare && "font-medium text-foreground"/);
  });

  it("stands the status word down the column when a side has no reading", () => {
    expect(DAY_TILE).toMatch(/"col-start-2 row-span-3 self-center text-right"/);
    expect(DAY_TILE).toMatch(/"col-start-3 row-span-3 self-center text-right"/);
    expect(RENDERED).toContain("figures.out.word");
    expect(RENDERED).toContain("figures.in.word");
  });

  it("widens the squares on a phone so the whole table is legible", () => {
    const grid = LOG.match(/"grid grid-cols-\d[^"]*xl:grid-cols-7"/);
    expect(grid).not.toBeNull();
    const classes = grid![0].slice(1, -1).split(" ");
    // Three across at the narrowest; four only where a container query says
    // there is room for it (2026-10-06, the chart beside the squares).
    expect(classes).toContain("grid-cols-3");
    expect(classes).not.toContain("grid-cols-4");
  });

  it("counts columns against the squares' own width, not the screen's", () => {
    // Beside the chart, a laptop leaves the squares two thirds of the card.
    // A viewport breakpoint would still pack seven into that and clip them.
    const grid = LOG.match(/"grid grid-cols-3 gap-1\.5[^"]*"/)![0]
      .slice(1, -1)
      .split(" ");
    const responsive = grid.filter((c) => c.includes(":"));
    expect(responsive.length).toBeGreaterThan(0);
    for (const c of responsive) expect(c).toMatch(/^@\w+:grid-cols-\d$/);
  });
});

describe("the log fills its own outside days", () => {
  it("runs the fetch by itself on open, once per job, only when a day can be filled", () => {
    const effect = LOG.match(/const autoFilledFor = useRef[\s\S]*?\n {2}\}, \[jobId, [^\]]*\]\);/);
    expect(effect).not.toBeNull();
    const body = effect![0];
    expect(body).toContain("outsideDaysToFill(tiles, outsideCtx)");
    expect(body).toContain("if (autoFilledFor.current === jobId) return;");
    expect(body).toContain("daysToFill === 0");
    expect(body).toContain("app.writesDisabled");
    expect(body).toContain("navigator.onLine === false");
    expect(body).toContain('void runFetch("auto")');
  });

  it("asks for a window sized to the record and refuses to write before it", () => {
    const fn = LOG.match(/const runFetch = async[\s\S]*?\n {2}\};\n/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("pastDays: backfillPastDays(recordStart, todayLocal())");
    expect(fn![0]).toContain("notBefore: recordStart");
    // A failed automatic fill is reported exactly like a tapped one.
    expect(fn![0]).toContain("setFetchFailure(describeOutsideFetchFailure(error))");
  });

  it("starts the record at the first square or the first machine, whichever is older", () => {
    const memo = LOG.match(/const recordStart = useMemo\([\s\S]*?\n {2}\}, \[[^\]]*\]\);/);
    expect(memo).not.toBeNull();
    expect(memo![0]).toContain("tiles[0]?.date");
    expect(memo![0]).toContain("placed_at");
    expect(memo![0]).toContain("dates.sort()[0]");
  });
});

describe("the nightly hook says why a fetch failed", () => {
  it("keeps each failed job's code and each provider's reason instead of a bare count", () => {
    const failBlock = HOOK.match(/if \(outcome\.source === null\) \{[\s\S]*?return;/);
    expect(failBlock).not.toBeNull();
    expect(failBlock![0]).toContain("outcome.code");
    expect(failBlock![0]).toContain("outcome.openMeteo.reason");
    // Never the URL: it carries the coordinates and, with a key, the key.
    expect(failBlock![0]).not.toMatch(/url|Url|\blat\b|\blon\b/);
  });

  it("answers with the status the run summary decides, 200 or 502", () => {
    const tail = HOOK.slice(HOOK.indexOf("summarizeNightlyRun({"));
    expect(tail).toMatch(/outcomes,/);
    expect(tail).toContain("rowsBySource,");
    expect(tail).toContain("return Response.json(body, { status });");
    // Both sources' rows are counted where they are queued.
    expect(HOOK).toContain("rowsBySource[outcome.source] += 1");
  });

  it("reads the paid key on the server only and passes it to the per-job fetch", () => {
    expect(HOOK).toMatch(/process\.env\.OPEN_METEO_API_KEY/);
    expect(HOOK).toContain("fetchJobOutside(job, { now, apiKey, settled, nwsCache })");
    expect(NIGHTLY).toMatch(
      /fetchOutsideConditions\(job\.lat, job\.lon, \{\s*apiKey: opts\.apiKey,/,
    );
    // The browser path never sees it.
    expect(LOG).not.toContain("OPEN_METEO_API_KEY");
  });

  it("keeps the NWS fallback on the server: the browser path stays Open-Meteo", () => {
    for (const file of [LOG, read("src/lib/drying-log.ts")]) {
      expect(file).not.toMatch(/outside-conditions-(nws|nightly)/);
      expect(file).not.toContain("weather.gov");
    }
  });
});
