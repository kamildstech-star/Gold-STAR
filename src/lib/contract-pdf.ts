/**
 * Contract rendering.
 *
 * One builder produces both the preview a staff member approves and the final
 * signed file, so what the office sees before sending is byte-for-byte the
 * document the customer receives — only the signature block differs.
 *
 * Branding resolves per job from the job's own office: its logo and its legal
 * entity footer. The eleven offices are separate legal entities, so a contract
 * that carries the wrong entity name is the wrong contract.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";

export type ContractBrand = {
  companyName: string;
  legalEntityName: string | null;
  officeName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  ein: string | null;
  /** PNG or JPEG bytes. Fetched by the caller so this stays isomorphic. */
  logo: Uint8Array | null;
  logoMime: string | null;
};

export type ContractSignature = {
  signerName: string;
  signerRole: string | null;
  signerEmail: string | null;
  signedAtIso: string;
  /** PNG data URL from the signature pad. */
  signatureDataUrl: string;
  ip: string | null;
  userAgent: string | null;
};

export type ContractInput = {
  title: string;
  /** Merge-resolved body text. Blank lines separate paragraphs. */
  body: string;
  meta: [string, string][];
  brand: ContractBrand;
  /** Answers the recipient supplied on the signing page, printed with the document. */
  filledFields?: [string, string][];
  signature?: ContractSignature | null;
  footerNote?: string | null;
};

const NAVY = rgb(0.063, 0.141, 0.239);
const GREY = rgb(0.42, 0.42, 0.42);
const GOLD = rgb(0.722, 0.627, 0.188);
const INK = rgb(0.1, 0.1, 0.1);

/** Helvetica is Latin-1 only; anything else would throw mid-render. */
function safe(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E\n\u00A0-\u00FF]/g, "");
}

/** Data URLs are decoded by hand: `fetch` on a data: URL is not available in the worker runtime. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of safe(text).split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

export async function buildContractPdf(input: ContractInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const PW = 612;
  const PH = 792;
  const M = 54;
  const W = PW - M * 2;
  const BOTTOM = 76;

  let page = pdf.addPage([PW, PH]);
  let y = PH - M;

  const newPage = () => {
    page = pdf.addPage([PW, PH]);
    y = PH - M;
  };
  const need = (h: number) => {
    if (y - h < BOTTOM) newPage();
  };
  const text = (
    s: string,
    opts: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number },
  ) => {
    const size = opts.size ?? 10;
    page.drawText(safe(s), {
      x: opts.x ?? M,
      y,
      size,
      font: opts.f ?? font,
      color: opts.color ?? INK,
    });
  };

  /* Header — office branding */
  let headerBottom = y;
  if (input.brand.logo && input.brand.logo.byteLength > 0) {
    try {
      const img =
        input.brand.logoMime === "image/jpeg" || input.brand.logoMime === "image/jpg"
          ? await pdf.embedJpg(input.brand.logo)
          : await pdf.embedPng(input.brand.logo);
      const h = 34;
      const w = (img.width / img.height) * h;
      page.drawImage(img, { x: M, y: y - h, width: Math.min(w, 180), height: h });
      headerBottom = y - h;
    } catch {
      // A broken logo must never stop a contract going out.
    }
  }
  if (headerBottom === y) {
    text(input.brand.companyName.toUpperCase(), { size: 15, f: bold, color: NAVY });
    headerBottom = y - 16;
  }

  const rightLines = [input.brand.officeName, input.brand.phone, input.brand.email].filter(
    Boolean,
  ) as string[];
  let ry = y - 2;
  for (const line of rightLines) {
    const w = font.widthOfTextAtSize(safe(line), 8);
    page.drawText(safe(line), { x: M + W - w, y: ry, size: 8, font, color: GREY });
    ry -= 10;
  }

  y = Math.min(headerBottom, ry) - 14;
  page.drawRectangle({ x: M, y, width: W, height: 3, color: GOLD });
  y -= 26;

  /* Title */
  text(input.title.toUpperCase(), { size: 13, f: bold, color: NAVY });
  y -= 20;

  /* Meta block */
  for (const [k, v] of input.meta) {
    need(14);
    text(`${k}:`, { size: 9, f: bold, color: GREY });
    page.drawText(safe(v || "—"), { x: M + 96, y, size: 9, font, color: NAVY });
    y -= 13;
  }
  y -= 12;

  /* Body */
  for (const line of wrap(input.body, font, 10, W)) {
    if (!line) {
      y -= 8;
      continue;
    }
    need(14);
    text(line, { size: 10 });
    y -= 14;
  }

  /* Recipient-supplied answers */
  if (input.filledFields?.length) {
    y -= 16;
    need(30);
    text("Information provided by the signer", { size: 9, f: bold, color: GREY });
    y -= 14;
    for (const [k, v] of input.filledFields) {
      need(13);
      text(`${k}:`, { size: 9, f: bold, color: GREY });
      page.drawText(safe(v || "—"), { x: M + 180, y, size: 9, font, color: NAVY });
      y -= 13;
    }
  }

  /* Signature block */
  if (input.signature) {
    const sig = input.signature;
    need(150);
    y -= 24;
    text("Signature", { size: 9, f: bold, color: GREY });
    y -= 8;
    try {
      const png = await pdf.embedPng(dataUrlToBytes(sig.signatureDataUrl));
      const sigW = Math.min(240, W);
      const sigH = (png.height / png.width) * sigW;
      y -= sigH;
      page.drawImage(png, { x: M, y, width: sigW, height: sigH });
      y -= 6;
      page.drawLine({ start: { x: M, y }, end: { x: M + sigW, y }, thickness: 0.8, color: NAVY });
      y -= 14;
    } catch {
      y -= 20;
    }
    const rows: [string, string][] = [
      ["Signed by", sig.signerName],
      ["Capacity", sig.signerRole ?? "Property owner"],
      ["Email", sig.signerEmail ?? "—"],
      ["Date signed", new Date(sig.signedAtIso).toLocaleString("en-US")],
      ["Timestamp", new Date(sig.signedAtIso).toISOString()],
    ];
    for (const [k, v] of rows) {
      need(12);
      text(`${k}:`, { size: 8, f: bold, color: GREY });
      page.drawText(safe(v), { x: M + 80, y, size: 8, font, color: NAVY });
      y -= 12;
    }
    if (sig.ip || sig.userAgent) {
      for (const line of wrap(
        `Electronically signed from ${sig.ip ?? "unknown address"} using ${sig.userAgent ?? "unknown device"}.`,
        font,
        7,
        W,
      )) {
        need(9);
        text(line, { size: 7, color: GREY });
        y -= 9;
      }
    }
  }

  /* Legal-entity footer on every page, like the invoices */
  const footer = [
    input.brand.legalEntityName ?? input.brand.companyName,
    input.brand.address,
    input.brand.ein ? `EIN ${input.brand.ein}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({
      start: { x: M, y: BOTTOM - 12 },
      end: { x: M + W, y: BOTTOM - 12 },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85),
    });
    p.drawText(safe(footer), { x: M, y: BOTTOM - 26, size: 7, font, color: GREY });
    if (input.footerNote) {
      p.drawText(safe(input.footerNote), { x: M, y: BOTTOM - 36, size: 7, font, color: GREY });
    }
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = font.widthOfTextAtSize(label, 7);
    p.drawText(label, { x: M + W - w, y: BOTTOM - 26, size: 7, font, color: GREY });
  });

  return pdf.save();
}
