/**
 * Where each photograph goes on an invoice.
 *
 * The client's own sizing: "nine, twelve pictures, three rows of three or
 * four, little squares on a page." So the grid is square cells, three across
 * for a handful and four across once there are more than nine, and rows flow
 * down the page and onto the next one like any other section of the document.
 *
 * Pure on purpose. It knows nothing about pdf-lib or about images; it takes a
 * count and the page geometry and answers with a rectangle per photograph and
 * which page it lands on. That is the part worth testing, and it is the part
 * that would otherwise be arithmetic buried in a drawing loop.
 *
 * Coordinates are PDF coordinates: y grows upward, and a cell's `y` is its
 * bottom edge, which is what `drawImage` wants.
 */

export type PhotoGridInput = {
  count: number;
  /** Left edge and full width of the printable band the grid sits in. */
  x0: number;
  width: number;
  /** The cursor: the y the first row's top edge may start at, on page 0. */
  startY: number;
  /** Where a row's top edge starts on a fresh page. */
  pageTop: number;
  /** The lowest a cell's bottom edge may go — the footer reserve. */
  pageBottom: number;
  /** Cells across. Defaults to `photoGridColumns(count)`. */
  columns?: number;
  /** Space between cells, in points. */
  gap?: number;
};

export type PhotoGridCell = {
  /** Position in the input order. */
  index: number;
  /** 0 is the page the cursor was on; each increment is one page break. */
  page: number;
  x: number;
  /** Bottom edge. */
  y: number;
  size: number;
};

export type PhotoGridLayout = {
  cells: PhotoGridCell[];
  columns: number;
  size: number;
  /** How many page breaks the grid needed. */
  pagesAdded: number;
  /** The cursor after the last row, on the last page the grid touched. */
  endY: number;
};

export const PHOTO_GRID_GAP = 8;

/**
 * Three across reads as "a few pictures"; four across keeps a dozen on one
 * sheet. Past nine the client said "three or four", and four is what makes
 * twelve photographs three rows rather than four.
 */
export function photoGridColumns(count: number): 3 | 4 {
  return count <= 9 ? 3 : 4;
}

/**
 * The band the invoice's grid actually lives in: US Letter portrait, 40pt
 * margins, and the 54pt the sheet reserves for its footer.
 *
 * Copied rather than imported because `pdf-kit` pulls pdf-lib in with it, and
 * the photo picker in the browser has no business loading a PDF engine to
 * decide what to warn about. `invoice-photo-grid.test.ts` asserts these still
 * equal pdf-kit's own numbers, so the copy cannot drift silently.
 */
export const INVOICE_PHOTO_BAND = {
  /** CONTENT_W */
  width: 532,
  /** PAGE_H - MARGIN */
  pageTop: 752,
  /** MARGIN + Sheet.footerH */
  pageBottom: 94,
} as const;

export type PhotoBand = { width: number; pageTop: number; pageBottom: number };

/** The square cell this many photographs get, at the column count they trigger. */
function cellSize(count: number, band: PhotoBand, gap: number) {
  const columns = photoGridColumns(count);
  return { columns, size: (band.width - gap * (columns - 1)) / columns };
}

/**
 * Gold Star's own rule, not the paper's: David asked at the 7 September 2026
 * walkthrough for no more than twelve photographs on any one printed page, so
 * that they stay big enough to be worth looking at. Landed in PR #42.
 *
 * This is a house limit. It is a decision someone made and can unmake — it is
 * not a measurement, and nothing about US Letter produces the number twelve.
 * `layoutPhotoGrid` enforces it, so it is the real per-page count, and the
 * editor's warning names it as a rule rather than dressing it up as geometry.
 * The last time the two were told apart, the office was warned at fifteen that
 * the invoice would run long, printed it, found all fifteen on one sheet, and
 * asked "it is showing on one sheet so what is the warning for".
 */
export const INVOICE_PHOTOS_PER_PAGE_LIMIT = 12;

/**
 * How many photographs the *page* can hold — the measurement, with no house
 * rule in it.
 *
 * Four columns of 127pt cells, four rows to the 658pt band, so sixteen fit and
 * seventeen cannot, whatever else is on the invoice. Kept as its own function
 * because it is the figure that moves when the cells or the margins move, and
 * because nobody should have to work out afterwards which of these two numbers
 * was measured and which was chosen.
 *
 * Today it is the looser of the two: the house limit of twelve binds first.
 */
export function photosPerSheetByGeometry(
  band: PhotoBand = INVOICE_PHOTO_BAND,
  gap = PHOTO_GRID_GAP,
): number {
  const available = band.pageTop - band.pageBottom;
  let most = 0;
  // The 3-column band is the bulkier one — nine photographs at 172pt are
  // taller than twelve at 127pt — so this cannot assume the fit is monotonic
  // in the count and simply walks the range.
  for (let count = 1; count <= 200; count++) {
    const { columns, size } = cellSize(count, band, gap);
    const rows = Math.ceil(count / columns);
    if (rows * size + (rows - 1) * gap <= available) most = count;
  }
  return most;
}

/**
 * What actually lands on one printed page: the house limit or the geometry,
 * whichever runs out first. Twelve today, because David's rule is tighter than
 * the sixteen the paper would take.
 */
export function photosPerSheet(band: PhotoBand = INVOICE_PHOTO_BAND, gap = PHOTO_GRID_GAP): number {
  return Math.min(photosPerSheetByGeometry(band, gap), INVOICE_PHOTOS_PER_PAGE_LIMIT);
}

/**
 * Pages of pictures this many photographs need, at best — that is, with the
 * grid starting on a fresh page. A grid that starts halfway down a page can
 * need one more, so this is the floor, and it is what the editor quotes.
 *
 * Asked of `layoutPhotoGrid` rather than divided out of a constant, so it
 * stays the truth about the paginator even if the paginator's rules change.
 */
export function photoGridSheets(
  count: number,
  band: PhotoBand = INVOICE_PHOTO_BAND,
  gap = PHOTO_GRID_GAP,
): number {
  if (count <= 0) return 0;
  return (
    layoutPhotoGrid({
      count,
      x0: 0,
      width: band.width,
      startY: band.pageTop,
      pageTop: band.pageTop,
      pageBottom: band.pageBottom,
      gap,
    }).pagesAdded + 1
  );
}

export function layoutPhotoGrid(input: PhotoGridInput): PhotoGridLayout {
  const gap = input.gap ?? PHOTO_GRID_GAP;
  const columns = Math.max(1, Math.floor(input.columns ?? photoGridColumns(input.count)));
  const available = Math.max(0, input.pageTop - input.pageBottom);
  /*
   * A cell is never taller than a whole page's worth of room: a photograph
   * that cannot fit on a fresh page would otherwise loop forever looking for
   * one. In practice the width rule wins by a mile — 532pt across three is
   * 172pt, against 650-odd of page.
   */
  const size = Math.max(1, Math.min((input.width - gap * (columns - 1)) / columns, available));
  const cells: PhotoGridCell[] = [];

  if (input.count <= 0) {
    return { cells, columns, size, pagesAdded: 0, endY: input.startY };
  }

  let page = 0;
  let photosOnPage = 0;
  let top = input.startY;
  let endY = input.startY;
  const rows = Math.ceil(input.count / columns);

  for (let row = 0; row < rows; row++) {
    /*
     * Rows move whole, and a page breaks for either of two quite different
     * reasons: the paper has run out (`top - size`), or Gold Star's own
     * per-page limit has (`INVOICE_PHOTOS_PER_PAGE_LIMIT`). Only the first is
     * a fact about US Letter.
     */
    if (
      top - size < input.pageBottom ||
      photosOnPage + Math.min(columns, input.count - row * columns) > INVOICE_PHOTOS_PER_PAGE_LIMIT
    ) {
      page += 1;
      top = input.pageTop;
      photosOnPage = 0;
    }
    const y = top - size;
    for (let col = 0; col < columns; col++) {
      const index = row * columns + col;
      if (index >= input.count) break;
      cells.push({ index, page, x: input.x0 + col * (size + gap), y, size });
      photosOnPage += 1;
    }
    endY = y;
    top = y - gap;
  }

  return { cells, columns, size, pagesAdded: page, endY };
}

/**
 * The line printed above the link on the invoice, and used in the email.
 *
 * It says what the link is and — only when the office allowed it — that the
 * full-resolution originals can be pulled from it. A view-only link says
 * nothing about downloading, because promising a download that the page then
 * refuses is worse than not mentioning one.
 */
export function invoicePhotoLinkLine(count: number, allowDownloadOriginal: boolean): string {
  const noun = count === 1 ? "photo" : "photos";
  const head =
    count > 0
      ? `The ${count} ${noun} from this job can be viewed online at the link below`
      : "Photos from this job can be viewed online at the link below";
  return allowDownloadOriginal
    ? `${head}, where the full-resolution originals can also be downloaded.`
    : `${head}.`;
}
