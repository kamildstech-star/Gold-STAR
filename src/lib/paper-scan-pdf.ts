/**
 * The browser half of a paper scan (12 Nov): the photo as the model reads it,
 * the photo as the PDF filed on the job's Documents ("don't put it in the
 * picture section, take it to the documents section in PDF format"), and the
 * photo's fingerprint for the duplicate check.
 */
import { sha256Hex } from "@/lib/document-templates";

/** Longest edge sent to the model: a full page of handwriting stays legible. */
export const SCAN_EDGE = 2200;
/** Longest edge kept in the filed PDF: sharp enough to read every signature. */
const PDF_EDGE = 3000;

const isPdf = (file: File) => file.type === "application/pdf" || /\.pdf$/i.test(file.name);

/** The picked photo (or a PDF's first page) drawn on a white canvas no larger than `edge`. */
async function drawn(file: File, edge: number): Promise<HTMLCanvasElement> {
  let source: CanvasImageSource;
  let w: number;
  let h: number;
  if (isPdf(file)) {
    const { openPdfDocument } = await import("@/lib/document-thumbnails");
    const pdf = await openPdfDocument(file);
    try {
      const page = await pdf.renderPage({ page: 1, maxEdge: edge });
      [source, w, h] = [page.canvas, page.canvas.width, page.canvas.height];
    } finally {
      pdf.close();
    }
  } else {
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(file);
    } catch {
      throw new Error(
        "This photo format cannot be read here. Take the photo again, or save it as JPEG or PNG.",
      );
    }
    [source, w, h] = [bmp, bmp.width, bmp.height];
  }
  const scale = Math.min(1, edge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The photo as a JPEG data URL for the model. */
export async function sheetDataUrl(file: File): Promise<string> {
  return (await drawn(file, SCAN_EDGE)).toDataURL("image/jpeg", 0.88);
}

/** The photo's SHA-256: the same file picked twice is the same sheet. */
export async function photoHash(file: File): Promise<string> {
  return sha256Hex(await file.arrayBuffer());
}

/**
 * The scan as a PDF. A PDF is filed as it came; a photo becomes one page,
 * Letter-sized and turned to match the photo, the picture fitted inside a
 * small margin.
 */
export async function photoToPdf(file: File, title: string): Promise<Uint8Array> {
  if (isPdf(file)) return new Uint8Array(await file.arrayBuffer());
  const canvas = await drawn(file, PDF_EDGE);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The photo could not be encoded."))),
      "image/jpeg",
      0.9,
    ),
  );
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Gold Star Recovery Hub");
  const jpg = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const landscape = jpg.width > jpg.height;
  const [pw, ph] = landscape ? [792, 612] : [612, 792];
  const margin = 18;
  const scale = Math.min((pw - margin * 2) / jpg.width, (ph - margin * 2) / jpg.height);
  const w = jpg.width * scale;
  const h = jpg.height * scale;
  const page = doc.addPage([pw, ph]);
  page.drawImage(jpg, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  return doc.save();
}
