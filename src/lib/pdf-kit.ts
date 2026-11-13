import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { DocumentAudience } from "@/lib/document-audience";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * A very small layout engine over pdf-lib. Enough to lay out the two
 * customer-facing documents (estimate, invoice) with wrapped columns, ruled
 * tables and page breaks — and nothing more. Everything is US Letter portrait
 * because that is what the office prints and what the carriers expect.
 */

export const PAGE_W = 612;
export const PAGE_H = 792;
export const MARGIN = 40;
export const CONTENT_W = PAGE_W - MARGIN * 2;

export const NAVY = rgb(0.063, 0.141, 0.239); // #10243D
export const BLUE = rgb(0.106, 0.373, 0.659); // #1B5FA8
export const GOLD = rgb(0.784, 0.584, 0.11); // #C8951C
export const INK = rgb(0.09, 0.11, 0.15);
export const MUTED = rgb(0.42, 0.45, 0.5);
export const LINE = rgb(0.83, 0.85, 0.88);
export const BAND = rgb(0.945, 0.957, 0.969);
export const GREEN = rgb(0.11, 0.53, 0.28);

export type Align = "left" | "right" | "center";

export type Col = {
  key: string;
  label: string;
  width: number;
  align?: Align;
  /** Smaller type — used for the wrapped description column. */
  small?: boolean;
  /** Wrap to at most this many lines, then ellipsise. */
  clamp?: number;
};

export type Cell = string | { text: string; bold?: boolean; color?: ReturnType<typeof rgb> };

export class Sheet {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
  /** Reserved space at the bottom of every page for the footer block. */
  footerH = 54;
  /**
   * Who ends up holding this paper. Required, and not defaulted: a document
   * nobody classified is the one that leaks, so the decision is made where the
   * sheet is created and is visible in the diff that adds a new document type.
   */
  readonly audience: DocumentAudience;

  private constructor(
    doc: PDFDocument,
    page: PDFPage,
    font: PDFFont,
    bold: PDFFont,
    audience: DocumentAudience,
  ) {
    this.doc = doc;
    this.page = page;
    this.font = font;
    this.bold = bold;
    this.audience = audience;
    this.y = PAGE_H - MARGIN;
  }

  static async create(audience: DocumentAudience) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([PAGE_W, PAGE_H]);
    return new Sheet(doc, page, font, bold, audience);
  }

  /** True when this document is going to someone outside the company. */
  get customerFacing() {
    return this.audience === "customer";
  }

  /**
   * Draws only on an internal document. Crew instruction, cost, margin and
   * anything else written for us rather than for the reader goes through here,
   * so it is skipped rather than remembered-about on a customer document.
   */
  internalOnly(draw: (s: Sheet) => void) {
    if (this.audience === "internal") draw(this);
  }

  addPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.y = PAGE_H - MARGIN;
  }

  /** Break to a new page when `h` points would run into the footer band. */
  ensure(h: number) {
    if (this.y - h < MARGIN + this.footerH) this.addPage();
  }

  widthOf(text: string, size: number, bold = false) {
    return (bold ? this.bold : this.font).widthOfTextAtSize(sanitize(text), size);
  }

  wrap(text: string, size: number, maxWidth: number, bold = false): string[] {
    const f = bold ? this.bold : this.font;
    const out: string[] = [];
    for (const para of sanitize(text).split("\n")) {
      if (!para.trim()) {
        out.push("");
        continue;
      }
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) <= maxWidth) {
          line = next;
        } else {
          if (line) out.push(line);
          line = word;
        }
      }
      if (line) out.push(line);
    }
    return out;
  }

  /** Wrap and clamp, returning the visible lines plus whether text was cut. */
  clamp(text: string, size: number, maxWidth: number, maxLines: number) {
    const lines = this.wrap(text, size, maxWidth);
    if (lines.length <= maxLines) return { lines, truncated: false };
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = ellipsise(kept[maxLines - 1]!, this.font, size, maxWidth);
    return { lines: kept, truncated: true };
  }

  text(
    text: string,
    x: number,
    y: number,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      align?: Align;
      width?: number;
    } = {},
  ) {
    const size = opts.size ?? 9;
    const b = !!opts.bold;
    let dx = x;
    if (opts.align === "right" && opts.width != null)
      dx = x + opts.width - this.widthOf(text, size, b);
    if (opts.align === "center" && opts.width != null)
      dx = x + (opts.width - this.widthOf(text, size, b)) / 2;
    this.page.drawText(sanitize(text), {
      x: dx,
      y,
      size,
      font: b ? this.bold : this.font,
      color: opts.color ?? INK,
    });
  }

  /** Write a paragraph at the cursor and advance it. */
  para(
    text: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      width?: number;
      leading?: number;
      x?: number;
    } = {},
  ) {
    const size = opts.size ?? 9;
    const leading = opts.leading ?? size + 3;
    const width = opts.width ?? CONTENT_W;
    const x = opts.x ?? MARGIN;
    for (const line of this.wrap(text, size, width, opts.bold)) {
      this.ensure(leading);
      this.y -= leading;
      if (line) this.text(line, x, this.y, { size, bold: opts.bold, color: opts.color });
    }
  }

  rule(color = LINE, thickness = 0.7) {
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_W - MARGIN, y: this.y },
      thickness,
      color,
    });
  }

  box(
    x: number,
    y: number,
    w: number,
    h: number,
    fill?: ReturnType<typeof rgb>,
    border?: ReturnType<typeof rgb>,
  ) {
    this.page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: fill,
      borderColor: border,
      borderWidth: border ? 0.7 : 0,
    });
  }

  gap(h: number) {
    this.y -= h;
  }

  /** Section caption: small caps-ish label over a hairline. */
  sectionLabel(label: string) {
    this.ensure(22);
    this.y -= 14;
    this.text(label.toUpperCase(), MARGIN, this.y, { size: 8, bold: true, color: NAVY });
    this.y -= 4;
    this.rule(NAVY, 0.9);
    this.y -= 2;
  }

  tableHeader(cols: Col[], x0 = MARGIN) {
    const h = 16;
    this.ensure(h + 8);
    this.y -= h;
    this.box(
      x0,
      this.y,
      cols.reduce((s, c) => s + c.width, 0),
      h,
      BAND,
    );
    let x = x0;
    for (const c of cols) {
      this.text(c.label.toUpperCase(), x + 4, this.y + 5, {
        size: 7,
        bold: true,
        color: NAVY,
        align: c.align,
        width: c.width - 8,
      });
      x += c.width;
    }
  }

  /**
   * One ruled row. Cells wrap inside their column; the row height is driven by
   * the tallest cell so a long description never overlaps its neighbours.
   */
  tableRow(
    cols: Col[],
    row: Record<string, Cell | undefined>,
    x0 = MARGIN,
    opts: { zebra?: boolean } = {},
  ) {
    const padY = 4;
    const cells = cols.map((c) => {
      const raw = row[c.key];
      const value = typeof raw === "string" ? { text: raw } : (raw ?? { text: "" });
      const size = c.small ? 7 : 8.5;
      const inner = c.width - 8;
      const { lines, truncated } = c.clamp
        ? this.clamp(value.text ?? "", size, inner, c.clamp)
        : { lines: this.wrap(value.text ?? "", size, inner, value.bold), truncated: false };
      return { c, value, size, lines, truncated };
    });
    const h = Math.max(...cells.map((s) => s.lines.length * (s.size + 2.5)), 12) + padY * 2;
    this.ensure(h);
    const top = this.y;
    this.y -= h;
    if (opts.zebra)
      this.box(
        x0,
        this.y,
        cols.reduce((s, c) => s + c.width, 0),
        h,
        BAND,
      );
    let x = x0;
    for (const s of cells) {
      let ly = top - padY - s.size;
      for (const line of s.lines) {
        this.text(line, x + 4, ly, {
          size: s.size,
          bold: s.value.bold,
          color: s.value.color ?? (s.c.small ? MUTED : INK),
          align: s.c.align,
          width: s.c.width - 8,
        });
        ly -= s.size + 2.5;
      }
      x += s.c.width;
    }
    this.page.drawLine({
      start: { x: x0, y: this.y },
      end: { x: x0 + cols.reduce((s, c) => s + c.width, 0), y: this.y },
      thickness: 0.5,
      color: LINE,
    });
    return cells.some((s) => s.truncated);
  }

  /** Right-hand totals stack: label / value pairs aligned to the right margin. */
  totals(
    rows: {
      label: string;
      value: string;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      rule?: boolean;
    }[],
    width = 220,
    /** Space kept between the figures and the right margin, for a stack set in a panel. */
    inset = 0,
  ) {
    const x = PAGE_W - MARGIN - width - inset;
    for (const r of rows) {
      this.ensure(16);
      this.y -= 15;
      if (r.rule) {
        this.page.drawLine({
          start: { x, y: this.y + 12 },
          end: { x: PAGE_W - MARGIN - inset, y: this.y + 12 },
          thickness: 0.7,
          color: LINE,
        });
      }
      this.text(r.label, x, this.y, {
        size: r.bold ? 9.5 : 9,
        bold: r.bold,
        color: r.bold ? INK : MUTED,
      });
      this.text(r.value, x, this.y, {
        size: r.bold ? 9.5 : 9,
        bold: r.bold,
        color: r.color ?? INK,
        align: "right",
        width,
      });
    }
  }

  /** Footer drawn on every page once the body is complete. */
  stampFooters(lines: string[]) {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      let y = MARGIN + 26;
      p.drawLine({
        start: { x: MARGIN, y: y + 12 },
        end: { x: PAGE_W - MARGIN, y: y + 12 },
        thickness: 0.7,
        color: LINE,
      });
      for (const line of lines) {
        const w = this.font.widthOfTextAtSize(sanitize(line), 7.5);
        p.drawText(sanitize(line), {
          x: (PAGE_W - w) / 2,
          y,
          size: 7.5,
          font: this.font,
          color: MUTED,
        });
        y -= 10;
      }
      const label = `Page ${i + 1} of ${pages.length}`;
      p.drawText(label, {
        x: PAGE_W - MARGIN - this.font.widthOfTextAtSize(label, 7.5),
        y: MARGIN + 26,
        size: 7.5,
        font: this.font,
        color: MUTED,
      });
    });
  }

  async save() {
    return this.doc.save();
  }
}

/** Helvetica has no glyphs for smart quotes and dashes — normalise them. */
export function sanitize(s: string) {
  return (s ?? "")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    })
    .join("");
}

function ellipsise(line: string, font: PDFFont, size: number, maxWidth: number) {
  let s = line;
  while (s.length > 4 && font.widthOfTextAtSize(`${s}...`, size) > maxWidth) s = s.slice(0, -1);
  return `${s.trimEnd()}...`;
}

export function money(n: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Number(n ?? 0),
  );
}

export function qty(n: number | null | undefined) {
  const v = Number(n ?? 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export function shortDate(d: string | null | undefined) {
  if (!d) return "";
  const dt = new Date(d.length <= 10 ? `${d}T12:00:00` : d);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString(DATE_LOCALE, US_DATE);
}
