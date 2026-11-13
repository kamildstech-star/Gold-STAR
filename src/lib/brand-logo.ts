/**
 * The Gold Star logo on generated paper (12 Nov: "Logo for invoices and
 * reports").
 *
 * One place decides which artwork prints, so the invoice, estimate, receipt,
 * job report, scope of work and calculator sheet cannot drift apart. An
 * office's own `logo_url` still wins on the billing documents; this is what
 * prints when it has none (today: every office).
 *
 * Two forms are supported because the logo arrived as both: a PNG with a
 * transparent background (public/gold-star-logo.png) and the vector PDFs in
 * public/brand/, drawn as vectors so they stay sharp when zoomed.
 *
 * Browser only in practice: the files are fetched from the site's own origin.
 * Where there is no origin (server code, tests) the fetch fails and the caller
 * prints the company name in type instead, as before.
 */
import type { PDFDocument, PDFPage } from "pdf-lib";

export type BrandLogoSource = { kind: "png" | "jpg" | "pdf"; url: string };

/** The artwork every generated document prints. */
export const BRAND_LOGO: BrandLogoSource = { kind: "png", url: "/gold-star-logo.png" };

/** Something that can be drawn at a size: an image or an embedded PDF page. */
export type PdfLogo = {
  width: number;
  height: number;
  draw: (page: PDFPage, box: { x: number; y: number; width: number; height: number }) => void;
};

const cache = new Map<string, Promise<Uint8Array | null>>();

function fetchBytes(url: string): Promise<Uint8Array | null> {
  let hit = cache.get(url);
  if (!hit) {
    hit = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return new Uint8Array(await res.arrayBuffer());
      } catch {
        return null;
      }
    })();
    // A failure is not remembered: the next document tries again.
    void hit.then((b) => {
      if (!b) cache.delete(url);
    });
    cache.set(url, hit);
  }
  return hit;
}

export function sourceFor(url: string): BrandLogoSource {
  const lower = url.toLowerCase().split("?")[0] ?? "";
  if (lower.endsWith(".pdf")) return { kind: "pdf", url };
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return { kind: "jpg", url };
  return { kind: "png", url };
}

/** Embed one logo source into `doc`, or null when it cannot be read. */
export async function embedLogoSource(
  doc: PDFDocument,
  source: BrandLogoSource,
  load: (url: string) => Promise<Uint8Array | null> = fetchBytes,
): Promise<PdfLogo | null> {
  const bytes = await load(source.url);
  if (!bytes) return null;
  try {
    if (source.kind === "pdf") {
      const [page] = await doc.embedPdf(bytes, [0]);
      if (!page) return null;
      return {
        width: page.width,
        height: page.height,
        draw: (p, box) => p.drawPage(page, box),
      };
    }
    const image = source.kind === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
    return {
      width: image.width,
      height: image.height,
      draw: (p, box) => p.drawImage(image, box),
    };
  } catch {
    return null;
  }
}

/** The office's own logo when it has one that loads, else the Gold Star logo. */
export async function embedOfficeOrBrandLogo(
  doc: PDFDocument,
  officeLogoUrl: string | null | undefined,
  load?: (url: string) => Promise<Uint8Array | null>,
): Promise<PdfLogo | null> {
  if (officeLogoUrl) {
    const own = await embedLogoSource(doc, sourceFor(officeLogoUrl), load);
    if (own) return own;
  }
  return embedLogoSource(doc, BRAND_LOGO, load);
}

/** Draw `logo` `width` wide with its top-left at (x, top); returns its height. */
export function drawLogo(
  page: PDFPage,
  logo: PdfLogo,
  x: number,
  top: number,
  width: number,
): number {
  const height = (logo.height / logo.width) * width;
  logo.draw(page, { x, y: top - height, width, height });
  return height;
}

/**
 * The top-left brand mark on a pdf-kit sheet: the logo `width` wide, the
 * sheet's cursor moved below it; or, with no logo to draw, `fallback` (which
 * prints the name in type and moves the cursor itself).
 */
export async function drawBrandMark(
  sheet: { doc: PDFDocument; page: PDFPage; y: number },
  x: number,
  width: number,
  gapBelow: number,
  fallback: () => void,
): Promise<boolean> {
  const logo = await embedLogoSource(sheet.doc, BRAND_LOGO);
  if (!logo) {
    fallback();
    return false;
  }
  const h = drawLogo(sheet.page, logo, x, sheet.y, width);
  sheet.y -= h + gapBelow;
  return true;
}
