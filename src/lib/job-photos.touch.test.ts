/**
 * The job photo album on a phone, from the mobile audit (#278): a selection
 * bar hidden behind the bottom nav and wrapping into a wall of buttons, folder
 * filing that only worked by drag and drop, no way to take the first photo
 * from the General tab, and a "drag & drop" line on a screen with nothing to
 * drag from.
 *
 * No DOM library in this repo, so these read the source and assert on
 * regex-extracted fragments — never the whole file, so an explanatory comment
 * cannot satisfy or break an assertion.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const SRC = readFileSync("src/components/job-photos.tsx", "utf8").replace(/\r\n/g, "\n");

/** The selection bar: from its opening div to the Cancel button. */
const BAR = (() => {
  const start = SRC.indexOf("{selectMode && (");
  const end = SRC.indexOf('aria-label="Clear selection"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end + 400);
})();

describe("the selection bar on a phone", () => {
  const classes = BAR.match(/<div className="([^"]*sticky[^"]*)"/)![1];

  it("sits on the scroll container's bottom edge — which the shell already lifts above the nav", () => {
    // The shell's <main> reserves 4rem for the phone nav, and sticky respects
    // it; above-mobile-nav would count the nav twice (measured: 72px gap).
    // The guard with the full reasoning is in mobile-field-audit.test.ts.
    expect(classes.split(/\s+/)).toContain("bottom-2");
    expect(classes).not.toContain("above-mobile-nav");
  });

  it("keeps the secondary actions in one element that is a hidden row on a phone and inline from md", () => {
    const more = BAR.match(/id="photo-selection-more"\s+className=\{`([^`]*)`\}/)![1];
    expect(more).toContain("md:contents");
    expect(more).toContain('moreOpen ? "max-md:grid" : "max-md:hidden"');
    // Everything that used to wrap is inside it, rendered once.
    const panel = BAR.slice(BAR.indexOf('id="photo-selection-more"'));
    for (const action of [
      "<JobPhotoShare",
      "<PhotoAttachReport",
      "<PhotoAttachInvoice",
      "PDF",
      "Tag{",
      "Remove{",
    ]) {
      expect(panel).toContain(action);
      expect(BAR.split(action).length - 1).toBe(1);
    }
  });

  it("has a More toggle only below md", () => {
    const at = BAR.indexOf("aria-expanded={moreOpen}");
    expect(at).toBeGreaterThan(-1);
    const toggle = BAR.slice(BAR.lastIndexOf("<Button", at), BAR.indexOf("</Button>", at));
    expect(toggle).toContain("md:hidden");
    expect(toggle).toContain("setMoreOpen((v) => !v)");
  });

  it("closes the More row with the selection", () => {
    const clear = SRC.match(/const clear = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/)![0];
    expect(clear).toContain("setMoreOpen(false)");
  });
});

describe("filing into a folder without dragging", () => {
  it("puts Move to folder on the bar's first row, wired to the same filing the rail's drop uses", () => {
    const beforeMore = BAR.slice(0, BAR.indexOf('id="photo-selection-more"'));
    const move = beforeMore.match(/<MoveToFolder[\s\S]*?\/>/)![0];
    expect(move).toContain("onMove={fileSelected}");
    expect(move).toContain("count={removable.length}");
    // The rail's drop target is untouched: desktop keeps drag and drop.
    expect(SRC).toContain("onDropPhotos={(folderId) => void fileSelected(folderId)}");
  });

  it("lists every folder, empty ones too, and a way back out of all of them", () => {
    const fn = SRC.match(/function MoveToFolder\([\s\S]*?\n}\n/)![0];
    expect(fn).toContain("flattenTree(buildTree(folders))");
    expect(fn).not.toContain("foldersWithPhotos");
    expect(fn).toContain("onClick={() => void move(f.id)}");
    expect(fn).toContain("onClick={() => void move(null)}");
  });
});

describe("the General tab can take the first photo", () => {
  const strip = SRC.slice(SRC.indexOf("export function JobPhotoStrip("));

  it("shows an empty state with a camera instead of rendering nothing", () => {
    const empty = strip.match(/if \(photos\.length === 0\) return [^;]*;/)![0];
    expect(empty).toContain("<JobPhotoStripEmpty");
    expect(empty).not.toMatch(/return null;$/);
  });

  it("the empty state's Take photo opens the rear camera and files through the shared upload path", () => {
    const fn = SRC.match(/function JobPhotoStripEmpty\([\s\S]*?\n}\n/)![0];
    expect(fn).toContain('capture="environment"');
    expect(fn).toContain("Take photo");
    expect(fn).toContain("queueJobPhotoFiles(job, app.userId, files,");
    // It must not claim the job is empty: it also shows while photos load.
    expect(fn).not.toMatch(/No photos on this job/);
  });

  it("the Pictures tab files through the same path", () => {
    const accept = SRC.match(/const accept = useCallback\([\s\S]*?\n {2}\);/)![0];
    expect(accept).toContain("await queueJobPhotoFiles(job, app.userId, files, {");
  });
});

describe("no drag-and-drop promise on a touch screen", () => {
  it("hides the drag line under a coarse pointer, and keeps the drop target", () => {
    const line = SRC.match(/<span className="([^"]*)">\s*Drag &amp; drop photos here/)![1];
    expect(line.split(/\s+/)).toContain("touch:hidden");
    const drop = SRC.match(/onDrop=\{\(e\) => \{[\s\S]{0,200}?\}\}/);
    expect(drop![0]).toContain("e.dataTransfer.files");
  });
});
