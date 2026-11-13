import { describe, expect, it } from "vitest";

import {
  INVOICE_PHOTOS_PER_PAGE_LIMIT,
  INVOICE_PHOTO_BAND,
  PHOTO_GRID_GAP,
  invoicePhotoLinkLine,
  layoutPhotoGrid,
  photoGridColumns,
  photoGridSheets,
  photosPerSheet,
  photosPerSheetByGeometry,
} from "@/lib/invoice-photo-grid";
import { INVOICE_PHOTO_SOFT_CAP, invoicePhotoLengthNote } from "@/lib/invoice-photos";
import { CONTENT_W, MARGIN, PAGE_H } from "@/lib/pdf-kit";

/** US Letter with the invoice's 40pt margins and its 54pt footer reserve. */
const PAGE = { x0: 40, width: 532, pageTop: 752, pageBottom: 94 };

describe("columns", () => {
  it("is three across up to nine pictures and four beyond", () => {
    expect(photoGridColumns(1)).toBe(3);
    expect(photoGridColumns(9)).toBe(3);
    expect(photoGridColumns(10)).toBe(4);
    expect(photoGridColumns(12)).toBe(4);
    expect(photoGridColumns(40)).toBe(4);
  });
});

describe("laying out the grid", () => {
  it("puts nine squares in three rows of three, top-down, left-to-right", () => {
    // Three rows of 172pt plus two gaps is 532pt; 700 leaves room for all of it.
    const out = layoutPhotoGrid({ ...PAGE, count: 9, startY: 700 });
    expect(out.columns).toBe(3);
    expect(out.cells).toHaveLength(9);
    expect(out.pagesAdded).toBe(0);
    // Square: the width rule, three across with two gaps.
    expect(out.size).toBeCloseTo((532 - 2 * PHOTO_GRID_GAP) / 3, 6);
    // Row 1 hangs from the cursor; every cell in it shares a bottom edge.
    const row1 = out.cells.slice(0, 3);
    for (const c of row1) expect(c.y).toBeCloseTo(700 - out.size, 6);
    expect(row1.map((c) => c.x)).toEqual([
      40,
      40 + out.size + PHOTO_GRID_GAP,
      40 + 2 * (out.size + PHOTO_GRID_GAP),
    ]);
    // Row 2 sits one gap below row 1.
    expect(out.cells[3]!.y).toBeCloseTo(row1[0]!.y - PHOTO_GRID_GAP - out.size, 6);
    // Indexes follow the input order.
    expect(out.cells.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out.endY).toBeCloseTo(out.cells[8]!.y, 6);
  });

  it("puts twelve pictures in three rows of four", () => {
    const out = layoutPhotoGrid({ ...PAGE, count: 12, startY: 700 });
    expect(out.columns).toBe(4);
    expect(out.cells).toHaveLength(12);
    const rows = new Set(out.cells.map((c) => c.y));
    expect(rows.size).toBe(3);
    expect(out.pagesAdded).toBe(0);
  });

  it("caps each page at twelve photos even when more would fit", () => {
    for (const count of [13, 15, 16, 25, 40]) {
      const out = layoutPhotoGrid({ ...PAGE, count, startY: PAGE.pageTop });
      const counts = new Map<number, number>();
      for (const cell of out.cells) counts.set(cell.page, (counts.get(cell.page) ?? 0) + 1);
      expect(out.cells).toHaveLength(count);
      expect(out.cells[12]!.page).toBe(1);
      for (const photos of counts.values()) expect(photos).toBeLessThanOrEqual(12);
    }
  });

  it("leaves the last row short rather than stretching it", () => {
    const out = layoutPhotoGrid({ ...PAGE, count: 7, startY: 700 });
    const lastRow = out.cells.filter((c) => c.y === out.cells[6]!.y);
    expect(lastRow).toHaveLength(1);
    expect(lastRow[0]!.x).toBe(40);
    expect(lastRow[0]!.size).toBeCloseTo(out.size, 6);
  });

  it("moves a row that would not fit to the next page, whole", () => {
    // Just under one cell of room left above the footer.
    const out = layoutPhotoGrid({ ...PAGE, count: 3, startY: PAGE.pageBottom + 100 });
    expect(out.pagesAdded).toBe(1);
    for (const c of out.cells) {
      expect(c.page).toBe(1);
      expect(c.y).toBeCloseTo(PAGE.pageTop - out.size, 6);
    }
  });

  it("never lets a cell's bottom edge cross the footer reserve", () => {
    for (const count of [1, 4, 9, 12, 20, 33]) {
      for (const startY of [PAGE.pageTop, 500, 300, PAGE.pageBottom + 10]) {
        const out = layoutPhotoGrid({ ...PAGE, count, startY });
        for (const c of out.cells) {
          expect(c.y).toBeGreaterThanOrEqual(PAGE.pageBottom);
          expect(c.y + c.size).toBeLessThanOrEqual(PAGE.pageTop + 1e-6);
        }
      }
    }
  });

  it("flows a long selection across pages in order", () => {
    const out = layoutPhotoGrid({ ...PAGE, count: 33, startY: 400 });
    expect(out.cells).toHaveLength(33);
    expect(out.columns).toBe(4);
    const pages = out.cells.map((c) => c.page);
    // Non-decreasing page numbers, and at least one break.
    for (let i = 1; i < pages.length; i++) expect(pages[i]).toBeGreaterThanOrEqual(pages[i - 1]!);
    expect(out.pagesAdded).toBeGreaterThan(0);
    expect(pages[pages.length - 1]).toBe(out.pagesAdded);
    // The cursor ends at the bottom of the last row on the last page.
    expect(out.endY).toBeCloseTo(out.cells[32]!.y, 6);
  });

  it("does nothing for an empty selection", () => {
    const out = layoutPhotoGrid({ ...PAGE, count: 0, startY: 640 });
    expect(out.cells).toEqual([]);
    expect(out.pagesAdded).toBe(0);
    expect(out.endY).toBe(640);
  });

  it("honors an explicit column count", () => {
    const out = layoutPhotoGrid({ ...PAGE, count: 6, startY: 700, columns: 2 });
    expect(out.columns).toBe(2);
    expect(new Set(out.cells.map((c) => c.y)).size).toBe(3);
  });
});

describe("the line under the link", () => {
  it("counts the pictures and pluralises", () => {
    expect(invoicePhotoLinkLine(1, false)).toContain("The 1 photo from this job");
    expect(invoicePhotoLinkLine(12, false)).toContain("The 12 photos from this job");
  });

  it("mentions downloading only when the office allowed it", () => {
    expect(invoicePhotoLinkLine(9, false)).not.toMatch(/download/i);
    expect(invoicePhotoLinkLine(9, true)).toMatch(
      /full-resolution originals can also be downloaded/,
    );
  });

  it("still reads when the count is unknown", () => {
    expect(invoicePhotoLinkLine(0, false)).toBe(
      "Photos from this job can be viewed online at the link below.",
    );
  });
});

/**
 * Two numbers that keep getting mistaken for one another: what David asked for
 * (twelve to a page) and what the paper can hold (sixteen). Each is asserted on
 * its own, so a change to either cannot hide behind the other.
 */
describe("how many photographs fit on a sheet", () => {
  it("keeps the picker's page geometry in step with the sheet's", () => {
    // The picker copies these rather than importing pdf-kit, which would drag
    // pdf-lib into the browser bundle. This is the seam that would drift.
    expect(INVOICE_PHOTO_BAND.width).toBe(CONTENT_W);
    expect(INVOICE_PHOTO_BAND.pageTop).toBe(PAGE_H - MARGIN);
    // MARGIN + Sheet.footerH, which is 54.
    expect(INVOICE_PHOTO_BAND.pageBottom).toBe(MARGIN + 54);
  });

  it("holds sixteen as a matter of geometry — four rows of four", () => {
    // The measurement, with no house rule in it: 127pt cells, 658pt of band.
    expect(photosPerSheetByGeometry()).toBe(16);
  });

  it("is limited to twelve a page by Gold Star, not by the paper", () => {
    // The rule David asked for, which is a smaller number than the paper's.
    expect(INVOICE_PHOTOS_PER_PAGE_LIMIT).toBe(12);
    expect(INVOICE_PHOTOS_PER_PAGE_LIMIT).toBeLessThan(photosPerSheetByGeometry());
  });

  it("prints the tighter of the two, which is twelve today", () => {
    expect(photosPerSheet()).toBe(12);
    expect(photosPerSheet()).toBe(
      Math.min(INVOICE_PHOTOS_PER_PAGE_LIMIT, photosPerSheetByGeometry()),
    );
    expect(INVOICE_PHOTO_SOFT_CAP).toBe(12);
  });

  it("lets a wider house limit hand the page back to the geometry", () => {
    // A taller band the house limit no longer binds on: the geometric figure
    // rises with the paper, and the printed figure follows it up to twelve.
    const tall = { ...INVOICE_PHOTO_BAND, pageBottom: 40 };
    expect(photosPerSheetByGeometry(tall)).toBeGreaterThan(photosPerSheetByGeometry());
    expect(photosPerSheet(tall)).toBe(INVOICE_PHOTOS_PER_PAGE_LIMIT);
  });

  /*
   * The layout function is the authority; this asserts the arithmetic above
   * agrees with it. Starting at the top of a clean page is the best case, so
   * it is the case the cap describes.
   */
  it("agrees with the layout at the top of a clean page", () => {
    const fits = (count: number) =>
      layoutPhotoGrid({
        count,
        x0: MARGIN,
        startY: INVOICE_PHOTO_BAND.pageTop,
        ...INVOICE_PHOTO_BAND,
      }).pagesAdded;

    expect(fits(12)).toBe(0);
    expect(fits(13)).toBe(1);
    expect(fits(15)).toBe(1);
    expect(fits(16)).toBe(1);
  });

  it("counts the sheets a selection needs, from the layout itself", () => {
    expect(photoGridSheets(0)).toBe(0);
    expect(photoGridSheets(9)).toBe(1);
    expect(photoGridSheets(12)).toBe(1);
    expect(photoGridSheets(13)).toBe(2);
    expect(photoGridSheets(16)).toBe(2);
    expect(photoGridSheets(32)).toBe(3);
    expect(photoGridSheets(33)).toBe(3);
  });

  it("reports whatever the paginator does, rather than a division", () => {
    // Not `ceil(count / 12)` by construction: it is read back off the layout,
    // so a change to how pages break shows up here without being restated.
    for (const count of [1, 9, 12, 13, 15, 16, 20, 25, 33, 37]) {
      const pages = new Set(
        layoutPhotoGrid({
          count,
          x0: MARGIN,
          startY: INVOICE_PHOTO_BAND.pageTop,
          ...INVOICE_PHOTO_BAND,
        }).cells.map((c) => c.page),
      );
      expect(photoGridSheets(count)).toBe(pages.size);
    }
  });
});

describe("what the editor tells the office", () => {
  it("says nothing about a selection that prints on one page", () => {
    expect(invoicePhotoLengthNote(12)).toBeNull();
    expect(invoicePhotoLengthNote(11)).toBeNull();
  });

  it("names the real cost once the grid needs a second sheet", () => {
    const note = invoicePhotoLengthNote(13);
    expect(note).toContain("13 photos");
    expect(note).toContain("2 pages");
    // It offers the link, which is the actual way out.
    expect(note).toMatch(/photo link/);
  });

  it("blames the house rule, not the length of the invoice", () => {
    // The wording that started all this. Fifteen do fit on a sheet of paper;
    // what they run into is Gold Star's own limit, so that is what it says.
    const note = invoicePhotoLengthNote(15);
    expect(note).toContain("Gold Star's limit is 12 photos to a page");
    expect(note).not.toMatch(/long invoice/i);
  });

  it("scales with the selection rather than repeating one sentence", () => {
    expect(invoicePhotoLengthNote(20)).toContain("20 photos print as 2 pages");
    expect(invoicePhotoLengthNote(37)).toContain("4 pages");
  });
});
