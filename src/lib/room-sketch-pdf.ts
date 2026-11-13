/**
 * The client-friendly plan (FE12): the room's sketch on one page with its
 * affected areas shaded, the equipment marked and labelled, a title block and
 * a legend. Drawn as vectors over the sketch image, so the shading stays
 * crisp when the carrier zooms in. Landscape when the sketch is wider than
 * tall.
 */
import {
  LineCapStyle,
  PDFDocument,
  StandardFonts,
  clip,
  closePath,
  endPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

import { formatDateUS } from "@/lib/date-format";
import { sanitize } from "@/lib/pdf-kit";
import {
  SKETCH_EQUIPMENT,
  SKETCH_INKS,
  SKETCH_SHADES,
  SKETCH_WALL_CUTS,
  arrowHead,
  doubleDrywall,
  equipmentCounts,
  fitInside,
  isClosedShape,
  shadeOf,
  shadesUsed,
  shapePolygon,
  stackOffset,
  wallLegend,
  wallNormal,
  type SketchWallCut,
  type SketchAnnotation,
  type SketchShade,
} from "@/lib/room-sketch";

const NAVY = rgb(0.063, 0.141, 0.239);
const MUTED = rgb(0.42, 0.45, 0.5);
const WHITE = rgb(1, 1, 1);

const shadeColor = (s: SketchShade) => {
  const [r, g, b] = SKETCH_SHADES[s].rgb;
  return rgb(r / 255, g / 255, b / 255);
};

/**
 * Fill a polygon (page coordinates) with a preset (T11): a pale wash and the
 * preset's lines, clipped to the shape — pdf-lib has no pattern fill, so the
 * lines are drawn across the shape's box inside a clip. Solid and the
 * original tint are plain fills.
 */
function fillShade(page: PDFPage, pts: readonly [number, number][], shade: SketchShade) {
  const color = shadeColor(shade);
  const pattern = SKETCH_SHADES[shade].pattern;
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${-y}`).join(" ") + " Z";
  if (pattern === "tint" || pattern === "solid") {
    page.drawSvgPath(path, {
      x: 0,
      y: 0,
      color,
      opacity: pattern === "solid" ? 0.6 : 0.32,
      borderColor: color,
      borderOpacity: 0.9,
      borderWidth: 1.2,
    });
    return;
  }
  if (pattern === "outline") {
    page.drawSvgPath(path, {
      x: 0,
      y: 0,
      borderColor: color,
      borderOpacity: 0.95,
      borderWidth: 1.8,
      borderDashArray: [5, 3],
    });
    return;
  }
  page.drawSvgPath(path, { x: 0, y: 0, color, opacity: pattern === "dotted" ? 0.12 : 0.14 });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  page.pushOperators(
    pushGraphicsState(),
    moveTo(pts[0]![0], pts[0]![1]),
    ...pts.slice(1).map(([x, y]) => lineTo(x, y)),
    closePath(),
    clip(),
    endPath(),
  );
  const gap = 5;
  if (pattern === "dotted") {
    for (let y = y0 + gap / 2; y <= y1; y += gap)
      for (let x = x0 + gap / 2; x <= x1; x += gap) page.drawCircle({ x, y, size: 0.9, color });
  }
  const span = pattern === "dotted" ? -1 : x1 - x0 + (y1 - y0);
  for (let d = -span; d <= span; d += gap) {
    if (pattern === "horizontal") {
      if (d < 0 || y0 + d > y1) continue;
      page.drawLine({
        start: { x: x0, y: y0 + d },
        end: { x: x1, y: y0 + d },
        thickness: 0.8,
        color,
      });
    } else if (pattern === "vertical") {
      if (d < 0 || x0 + d > x1) continue;
      page.drawLine({
        start: { x: x0 + d, y: y0 },
        end: { x: x0 + d, y: y1 },
        thickness: 0.8,
        color,
      });
    } else {
      const up = pattern === "diagonal_up";
      page.drawLine({
        start: { x: x0 + d, y: up ? y0 : y1 },
        end: { x: x0 + d + (y1 - y0), y: up ? y1 : y0 },
        thickness: 0.8,
        color,
      });
    }
  }
  page.pushOperators(popGraphicsState());
  page.drawSvgPath(path, { x: 0, y: 0, borderColor: color, borderOpacity: 0.9, borderWidth: 1.2 });
}

/**
 * A wall mark on the PDF (11 Nov): dotted for a flood cut — round dots, bigger
 * for the higher cut — solid for a full wall demo, in the cut's colour.
 */
/** A wall cut's line thickness on the PDF: thin, regular or heavy. */
const wallThickness = (cut: SketchWallCut) => [1.1, 2, 3.6][SKETCH_WALL_CUTS[cut].weight] ?? 2;

function drawWallLine(
  page: PDFPage,
  from: { x: number; y: number },
  to: { x: number; y: number },
  cut: SketchWallCut,
  /** Sideways shift in line widths: a double-drywall pair sits side by side. */
  offset = 0,
) {
  const meta = SKETCH_WALL_CUTS[cut];
  const [r, g, b] = meta.rgb;
  const thickness = wallThickness(cut);
  const [nx, ny] = wallNormal([from.x, from.y], [to.x, to.y]);
  const shift = offset * thickness;
  page.drawLine({
    start: { x: from.x + nx * shift, y: from.y + ny * shift },
    end: { x: to.x + nx * shift, y: to.y + ny * shift },
    thickness,
    color: rgb(r / 255, g / 255, b / 255),
    lineCap: LineCapStyle.Round,
    ...(meta.line === "dotted" ? { dashArray: [0, thickness * 1.9] } : {}),
  });
}

function wallLegendItem(page: PDFPage, font: PDFFont, cut: SketchWallCut): LegendItem {
  const label = SKETCH_WALL_CUTS[cut].label;
  return {
    width: 30 + font.widthOfTextAtSize(label, 8.5),
    draw: (x, y) => {
      drawWallLine(page, { x: x + 2, y: y + 3 }, { x: x + 20, y: y + 3 }, cut);
      page.drawText(label, { x: x + 24, y, size: 8.5, font, color: NAVY });
    },
  };
}

/** "Double drywall – <cut>", drawn as the cut's line twice, side by side (11 Nov). */
function doubleLegendItem(page: PDFPage, font: PDFFont, cut: SketchWallCut): LegendItem {
  const label = `Double drywall - ${SKETCH_WALL_CUTS[cut].label}`;
  return {
    width: 30 + font.widthOfTextAtSize(label, 8.5),
    draw: (x, y) => {
      for (const o of [-1.1, 1.1])
        drawWallLine(page, { x: x + 2, y: y + 3 }, { x: x + 20, y: y + 3 }, cut, o);
      page.drawText(label, { x: x + 24, y, size: 8.5, font, color: NAVY });
    },
  };
}

/** The legend's entries in reading order: shading presets, wall cuts, then equipment. */
type LegendItem = { width: number; draw: (x: number, y: number) => void };

function layoutLegend(items: LegendItem[], left: number, right: number) {
  const rows: LegendItem[][] = [[]];
  let x = left;
  for (const it of items) {
    if (x + it.width > right && rows[rows.length - 1]!.length) {
      rows.push([]);
      x = left;
    }
    rows[rows.length - 1]!.push(it);
    x += it.width;
  }
  return rows;
}

function shadeLegendItem(page: PDFPage, font: PDFFont, s: SketchShade): LegendItem {
  const label = SKETCH_SHADES[s].label;
  return {
    width: 26 + font.widthOfTextAtSize(label, 8.5),
    draw: (x, y) => {
      fillShade(
        page,
        [
          [x, y - 2],
          [x + 16, y - 2],
          [x + 16, y + 9],
          [x, y + 9],
        ],
        s,
      );
      page.drawText(label, { x: x + 20, y, size: 8.5, font, color: NAVY });
    },
  };
}

export type SketchPdfInput = {
  image: Uint8Array;
  mime: string;
  annotations: readonly SketchAnnotation[];
  title: string;
  subtitle: string | null;
  date: string;
};

export async function buildRoomSketchPdf(input: SketchPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const img = /png/i.test(input.mime)
    ? await pdf.embedPng(input.image)
    : await pdf.embedJpg(input.image);

  const landscape = img.width > img.height;
  const [W, H] = landscape ? [792, 612] : [612, 792];
  const page = pdf.addPage([W, H]);
  const M = 36;

  // Title block.
  page.drawText(sanitize(input.title), { x: M, y: H - M - 14, size: 15, font: bold, color: NAVY });
  const sub = [input.subtitle, formatDateUS(input.date)].filter(Boolean).join("  ·  ");
  page.drawText(sanitize(sub), { x: M, y: H - M - 30, size: 9, font, color: MUTED });
  page.drawLine({
    start: { x: M, y: H - M - 38 },
    end: { x: W - M, y: H - M - 38 },
    thickness: 1,
    color: NAVY,
  });

  // The legend's height is known before the image is placed: shading presets
  // (T11) then equipment, wrapped onto as many rows as the page needs.
  const counts = equipmentCounts(input.annotations);
  const doubled = doubleDrywall(input.annotations);
  const legendItems: LegendItem[] = [
    ...shadesUsed(input.annotations).map((s) => shadeLegendItem(page, font, s)),
    ...wallLegend(input.annotations).walls.map((c) => wallLegendItem(page, font, c)),
    ...doubled.cuts.map((c) => doubleLegendItem(page, font, c)),
    ...counts.map((c): LegendItem => {
      const meta = SKETCH_EQUIPMENT[c.equipment];
      const text = sanitize(`${meta.label} × ${c.count}`);
      return {
        width: 24 + font.widthOfTextAtSize(text, 8.5),
        draw: (lx, ly) => {
          page.drawCircle({ x: lx + 6, y: ly + 3, size: 6, color: NAVY });
          const lw = bold.widthOfTextAtSize(meta.letter, 7);
          page.drawText(meta.letter, {
            x: lx + 6 - lw / 2,
            y: ly + 0.6,
            size: 7,
            font: bold,
            color: WHITE,
          });
          page.drawText(text, { x: lx + 16, y: ly, size: 8.5, font, color: NAVY });
        },
      };
    }),
  ];
  const legendRows = layoutLegend(legendItems, M, W - M);
  const legendH = legendItems.length ? 26 + 14 * legendRows.length : 0;

  const boxTop = H - M - 48;
  const boxBottom = M + legendH;
  const fit = fitInside(img.width, img.height, W - 2 * M, boxTop - boxBottom);
  const x0 = M + (W - 2 * M - fit.width) / 2;
  const yTop = boxTop - (boxTop - boxBottom - fit.height) / 2;
  page.drawImage(img, { x: x0, y: yTop - fit.height, width: fit.width, height: fit.height });

  const px = (fx: number) => x0 + fx * fit.width;
  const py = (fy: number) => yTop - fy * fit.height;

  // Areas first, so markers and labels sit on top of the shading.
  for (const a of input.annotations) {
    if (a.kind !== "area") continue;
    fillShade(
      page,
      a.points.map(([fx, fy]) => [px(fx), py(fy)] as [number, number]),
      shadeOf(a),
    );
  }
  // 6 Nov: a circle or rectangle with a cut preset is shaded like an area.
  for (const a of input.annotations) {
    if (a.kind !== "shape" || !a.shade || !isClosedShape(a.shape)) continue;
    fillShade(
      page,
      shapePolygon(a).map(([fx, fy]) => [px(fx), py(fy)] as [number, number]),
      a.shade,
    );
  }
  // Wall marks along the walls, over the shading.
  input.annotations.forEach((a, i) => {
    if (a.kind !== "wall") return;
    const stack = doubled.stack.get(i);
    drawWallLine(
      page,
      { x: px(a.from[0]), y: py(a.from[1]) },
      { x: px(a.to[0]), y: py(a.to[1]) },
      a.cut,
      stack ? stackOffset(stack.place, stack.of) : 0,
    );
  });
  // Drawing aids (line, arrow, circle, rectangle) over the shading, under the
  // markers and labels. A shaded shape keeps its outline, in its preset's colour.
  for (const a of input.annotations) {
    if (a.kind !== "shape") continue;
    const shaded = a.shade && isClosedShape(a.shape) ? a.shade : null;
    const [r, g, b] = shaded ? SKETCH_SHADES[shaded].rgb : SKETCH_INKS[a.ink].rgb;
    const color = rgb(r / 255, g / 255, b / 255);
    const p1 = { x: px(a.from[0]), y: py(a.from[1]) };
    const p2 = { x: px(a.to[0]), y: py(a.to[1]) };
    const thickness = 1.4;
    if (a.shape === "line" || a.shape === "arrow") {
      page.drawLine({ start: p1, end: p2, thickness, color, lineCap: LineCapStyle.Round });
      if (a.shape === "arrow") {
        for (const end of arrowHead([p1.x, p1.y], [p2.x, p2.y], 7)) {
          page.drawLine({
            start: p2,
            end: { x: end[0], y: end[1] },
            thickness,
            color,
            lineCap: LineCapStyle.Round,
          });
        }
      }
    } else {
      const x = Math.min(p1.x, p2.x);
      const y = Math.min(p1.y, p2.y);
      const w = Math.abs(p2.x - p1.x);
      const h = Math.abs(p2.y - p1.y);
      if (a.shape === "circle") {
        page.drawEllipse({
          x: x + w / 2,
          y: y + h / 2,
          xScale: w / 2,
          yScale: h / 2,
          borderColor: color,
          borderWidth: thickness,
        });
      } else {
        page.drawRectangle({
          x,
          y,
          width: w,
          height: h,
          borderColor: color,
          borderWidth: thickness,
        });
      }
    }
  }
  for (const a of input.annotations) {
    if (a.kind === "marker") {
      const r = 8;
      page.drawCircle({
        x: px(a.x),
        y: py(a.y),
        size: r,
        color: NAVY,
        borderColor: WHITE,
        borderWidth: 1,
      });
      const letter = SKETCH_EQUIPMENT[a.equipment].letter;
      const lw = bold.widthOfTextAtSize(letter, 9);
      page.drawText(letter, {
        x: px(a.x) - lw / 2,
        y: py(a.y) - 3.2,
        size: 9,
        font: bold,
        color: WHITE,
      });
    } else if (a.kind === "label") {
      const text = sanitize(a.text);
      const tw = font.widthOfTextAtSize(text, 9);
      page.drawRectangle({
        x: px(a.x) - 3,
        y: py(a.y) - 4,
        width: tw + 6,
        height: 14,
        color: WHITE,
        opacity: 0.85,
      });
      page.drawText(text, { x: px(a.x), y: py(a.y), size: 9, font, color: NAVY });
    }
  }

  // Legend, under the sketch.
  legendRows.forEach((row, r) => {
    let lx = M;
    const ly = M + 12 + 14 * (legendRows.length - 1 - r);
    for (const it of row) {
      it.draw(lx, ly);
      lx += it.width;
    }
  });

  return pdf.save();
}
