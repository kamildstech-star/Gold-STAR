/**
 * Mark, looking at a job's All Photos view: "while in the job dont shnow the
 * address". The tile's caption bar is gone; these tests are here so nobody
 * puts it back, and so the things the bar sat next to — the tick box, the drag
 * handle, the folder drop targets — are proved to have survived its removal.
 *
 * There is no DOM testing library in this repo, so this reads the source and
 * asserts on regex-extracted fragments rather than on the whole file: an
 * explanatory comment must not be able to satisfy or break an assertion.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SOURCE = readFileSync("src/components/job-photos.tsx", "utf8").replace(/\r\n/g, "\n");

/** Just the tile component, up to the line that re-exports it as PhotoTile. */
const TILE = (() => {
  const start = SOURCE.indexOf("function Thumb({");
  const end = SOURCE.indexOf("export { Thumb as PhotoTile };");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
})();

describe("the in-job photo tile carries no address", () => {
  it("prints the album name nowhere on the picture", () => {
    // One mention only, and it is the hover tooltip — not a rendered child.
    const mentions = TILE.match(/photo\.sourceLabel/g) ?? [];
    expect(mentions).toHaveLength(1);
    const title = TILE.match(/title=\{`[^`]*`\}/);
    expect(title![0]).toContain("photo.sourceLabel");
  });

  it("has no always-on caption bar across the bottom of the frame", () => {
    // The bar was `inset-x-0 bottom-0 flex ...` with no opacity gate. Anything
    // pinned to the bottom edge now has to hide itself until hover.
    const bottomBars = TILE.match(/className="[^"]*absolute inset-x-0 bottom-0[^"]*"/g) ?? [];
    expect(bottomBars).toHaveLength(1);
    expect(bottomBars[0]).toContain("opacity-0");
    expect(bottomBars[0]).toContain("group-hover:opacity-100");
  });

  it("keeps the capture time, on hover and only where hovering is possible", () => {
    const bar = TILE.match(/className="[^"]*absolute inset-x-0 bottom-0[^"]*"/)![0];
    // Hidden below sm: a finger cannot hover, so on a phone this would just be
    // the caption bar again.
    expect(bar).toContain("hidden");
    expect(bar).toContain("sm:flex");
    expect(TILE).toContain("toLocaleTimeString");
  });
});

describe("what the tile still does", () => {
  it("keeps the selection checkbox and its hit area", () => {
    const checkbox = TILE.slice(TILE.indexOf("<Checkbox"));
    expect(checkbox).toContain('aria-label={selected ? "Deselect photo" : "Select photo"}');
    expect(checkbox).toContain("onToggle?.(");
    // size-11 is the touch target; it must not have been traded for density.
    const hit = TILE.match(/className=\{`absolute left-0 top-0[^`]*`\}/);
    expect(hit![0]).toContain("size-11");
  });

  it("keeps the tile draggable, which is how photos reach a folder", () => {
    expect(TILE).toContain("draggable={!!onDragStart}");
    expect(TILE).toContain("onDragStart={onDragStart}");
  });

  it("defers signing a thumbnail URL until the tile is near the viewport", () => {
    // 179 tiles on the job that prompted this; a big loss job runs to
    // thousands, and each tile is a signed-URL round trip.
    expect(TILE).toContain("IntersectionObserver");
    expect(TILE).toContain('loading="lazy"');
  });
});

describe("the album grid", () => {
  /** The date group inside the Pictures grid: header row plus its tiles. */
  const DATE_GROUP = (() => {
    const start = SOURCE.indexOf("{rows.map((day) => (");
    expect(start).toBeGreaterThan(-1);
    return SOURCE.slice(start, start + 2000);
  })();

  it("puts the count for the date on the date header, right-aligned", () => {
    const header = DATE_GROUP.match(/className="flex items-baseline justify-between[^"]*"/);
    expect(header).not.toBeNull();
    expect(header![0]).toContain("uppercase");
    // The database's count for the day, not the tiles loaded so far — see
    // job-photos.cap.test.ts for why the length of the list stopped being it.
    expect(DATE_GROUP).toContain("{countText(day)}");
  });

  it("runs tighter gutters and more photos per row, three across on a phone", () => {
    const grid = DATE_GROUP.match(/className="grid grid-cols-3[^"]*"/);
    expect(grid![0]).toContain("gap-1 ");
    expect(grid![0]).not.toContain("gap-1.5");
    expect(grid![0]).toContain("sm:grid-cols-6");
    expect(grid![0]).toContain("lg:grid-cols-8");
  });
});

describe("the metadata the tile stopped showing has somewhere else to be", () => {
  /** The viewer's context footer. */
  const VIEWER_FOOTER = (() => {
    const start = SOURCE.indexOf('<Badge variant="outline">{photo.sourceLabel}</Badge>');
    expect(start).toBeGreaterThan(-1);
    return SOURCE.slice(start - 400, start + 400);
  })();

  it("shows the album name in the opened photo's footer", () => {
    expect(VIEWER_FOOTER).toContain('<Badge variant="outline">{photo.sourceLabel}</Badge>');
  });

  it("shows the full capture date and time beside the uploader", () => {
    const stamp = SOURCE.match(
      /className="tabular-nums text-muted-foreground">\{t\.toLocaleString\("en-US"\)\}/,
    );
    expect(stamp).not.toBeNull();
  });
});

describe("the drop targets the caption bar sat among", () => {
  it("keeps the card-level file drop that files into the job album", () => {
    expect(SOURCE).toContain("Drag &amp; drop photos here");
    const drop = SOURCE.match(/onDrop=\{\(e\) => \{[\s\S]{0,200}?\}\}/);
    expect(drop![0]).toContain("e.dataTransfer.files");
  });

  it("keeps the folder rail as the drop target for selected photos", () => {
    expect(SOURCE).toContain("onDropPhotos={(folderId) => void fileSelected(folderId)}");
  });
});
