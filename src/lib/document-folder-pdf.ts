/**
 * A whole document folder as ONE PDF.
 *
 * David, 13 Oct: the job's Sign-in sheets, Supply lists and Field forms
 * folders (filed automatically since 12 Oct) fill up a day at a time, and he
 * shares them with the carrier as a set — so a folder must come out as a
 * single PDF.
 *
 * Every PDF in the folder is copied in page by page, oldest first (the order
 * the days happened). A JPEG or PNG becomes one page, fitted inside the
 * margins. Anything else — an ESX, a spreadsheet, a HEIC the browser could
 * not decode, a damaged or locked PDF — is not dropped silently: it is named
 * on a closing "Not included" page, the way the photo PDF prints what it
 * skipped.
 *
 * pdf-lib is imported dynamically: statically imported from a module a route
 * reaches, its tslib interop 500s every page under the Workers runtime (see
 * photo-pdf.ts). Load this module itself with `await import(...)`.
 */

export type FolderPdfItem = {
  name: string;
  /** From `documentKind(name, mime)`. */
  kind: "pdf" | "image" | "esx" | "text" | "other";
  bytes: Uint8Array;
  /**
   * Already known not to go in, and why — named on the "Not included" page
   * in these words rather than as an unreadable file.
   */
  skipReason?: string;
};

export type FolderPdfResult = {
  bytes: Uint8Array;
  pages: number;
  included: string[];
  skipped: { name: string; reason: string }[];
};

const PW = 612;
const PH = 792;
const M = 40;

/** pdf-lib reads `bytes.buffer` without the view's offset; hand it a buffer of its own. */
function standalone(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** "Sign-in sheets" -> "sign-in-sheets", for a file name. */
export function folderPdfFilename(folderName: string, jobNumber?: string | null): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  return [jobNumber ? slug(jobNumber) : null, slug(folderName) || "folder"]
    .filter(Boolean)
    .join("-")
    .concat(".pdf");
}

export async function mergeFolderPdf(input: {
  title: string;
  items: readonly FolderPdfItem[];
}): Promise<FolderPdfResult> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const out = await PDFDocument.create();
  out.setTitle(input.title);
  const included: string[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const item of input.items) {
    if (item.skipReason) {
      skipped.push({ name: item.name, reason: item.skipReason });
      continue;
    }
    const bytes = standalone(item.bytes);
    if (item.kind === "pdf") {
      try {
        const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        for (const p of pages) out.addPage(p);
        included.push(item.name);
      } catch {
        skipped.push({ name: item.name, reason: "the PDF could not be read" });
      }
      continue;
    }
    if (item.kind === "image" && (isPng(bytes) || isJpeg(bytes))) {
      try {
        const img = isPng(bytes) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        const scale = Math.min((PW - M * 2) / img.width, (PH - M * 2) / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        const page = out.addPage([PW, PH]);
        page.drawImage(img, { x: (PW - w) / 2, y: (PH - h) / 2, width: w, height: h });
        included.push(item.name);
      } catch {
        skipped.push({ name: item.name, reason: "the image could not be read" });
      }
      continue;
    }
    skipped.push({
      name: item.name,
      reason:
        item.kind === "image"
          ? "only JPEG and PNG images can go in a PDF"
          : "not a PDF or an image",
    });
  }

  if (skipped.length || included.length === 0) {
    const font = await out.embedFont(StandardFonts.Helvetica);
    const bold = await out.embedFont(StandardFonts.HelveticaBold);
    const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "-");
    const page = out.addPage([PW, PH]);
    let y = PH - M - 10;
    page.drawText(ascii(included.length ? "Not included" : `${input.title}: nothing to include`), {
      x: M,
      y,
      size: 14,
      font: bold,
      color: rgb(0.06, 0.14, 0.24),
    });
    y -= 22;
    for (const s of skipped) {
      if (y < M) break;
      page.drawText(ascii(`${s.name} - ${s.reason}`).slice(0, 110), { x: M, y, size: 10, font });
      y -= 15;
    }
  }

  return { bytes: await out.save(), pages: out.getPageCount(), included, skipped };
}
