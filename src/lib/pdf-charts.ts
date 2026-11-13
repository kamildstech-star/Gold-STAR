/**
 * Line and bar charts drawn with pdf-lib's own primitives.
 *
 * The drying report needs charts a carrier can zoom into without them turning
 * to mush, which rules out screenshotting the on-screen recharts output into a
 * bitmap. pdf-lib already draws lines, circles and rectangles as vectors, and
 * a drying chart is nothing more than those plus text, so this is a hundred
 * lines of arithmetic rather than a second charting dependency (and it cannot
 * be broken by a recharts major-version upgrade).
 *
 * The one rule that is not cosmetic: a `null` value is a day with no reading.
 * It is never drawn as zero. Two readings either side of a missing day are
 * joined with a thin dotted segment — the trend is still readable, and the
 * dotting says nobody measured in between — and the missing day gets no
 * marker and no label.
 */
import { rgb, type RGB } from "pdf-lib";

import { INK, LINE, MUTED, type Sheet } from "@/lib/pdf-kit";

export type Box = { x: number; y: number; w: number; h: number };

export type LineSeries = {
  name: string;
  color: RGB;
  values: (number | null)[];
  /** Per point: draw the marker hollow (e.g. a modelled, not measured, figure). */
  hollow?: boolean[];
  decimals?: number;
};

export type RefLine = { value: number; color: RGB; label?: string };

export type BarSeries = { name: string; color: RGB; values: number[] };

/** Round tick spacing (1, 2, 2.5, 5 × 10^n) covering [min, max] in about `ticks` steps. */
export function niceScale(
  min: number,
  max: number,
  ticks = 5,
): { min: number; max: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.2 };
  if (min === max) {
    const pad = Math.abs(min) > 1 ? Math.abs(min) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}

/** Print every `stride`-th label so no more than `max` fit along an axis. */
export function labelStride(count: number, max: number): number {
  if (count <= max) return 1;
  return Math.ceil(count / max);
}

/** "2026-05-23" → "5/23". */
export function dayLabel(date: string): string {
  const [, m, d] = date.split("-");
  return m && d ? `${Number(m)}/${Number(d)}` : date;
}

export function formatValue(v: number, decimals = 0): string {
  const f = v.toFixed(decimals);
  return decimals > 0 ? f.replace(/\.?0+$/, "") : f;
}

const WHITE = rgb(1, 1, 1);
const GRID = rgb(0.88, 0.89, 0.91);

type Plot = { left: number; right: number; bottom: number; top: number };

/** Title on top, legend underneath, the plot in between. Returns the plot rectangle. */
function frame(
  s: Sheet,
  box: Box,
  title: string,
  legend: { name: string; color: RGB; dashed?: boolean }[],
): Plot {
  s.text(title, box.x, box.y + box.h - 11, { size: 10, bold: true, align: "center", width: box.w });

  // Legend rows, wrapped to the box width, laid out bottom-up.
  const items = legend.map((l) => ({ ...l, w: 16 + s.widthOf(l.name, 7.5) + 12 }));
  const rows: (typeof items)[] = [[]];
  let used = 0;
  for (const it of items) {
    if (used + it.w > box.w && rows[rows.length - 1]!.length > 0) {
      rows.push([]);
      used = 0;
    }
    rows[rows.length - 1]!.push(it);
    used += it.w;
  }
  const legendH = rows.length * 11;
  rows.forEach((row, ri) => {
    const total = row.reduce((n, it) => n + it.w, 0);
    let x = box.x + (box.w - total) / 2;
    const y = box.y + legendH - (ri + 1) * 11 + 3;
    for (const it of row) {
      s.page.drawLine({
        start: { x, y: y + 2.5 },
        end: { x: x + 12, y: y + 2.5 },
        thickness: it.dashed ? 1 : 2,
        color: it.color,
        dashArray: it.dashed ? [2, 1.5] : undefined,
      });
      s.text(it.name, x + 16, y, { size: 7.5, color: INK });
      x += it.w;
    }
  });

  return {
    left: box.x + 34,
    right: box.x + box.w - 8,
    bottom: box.y + legendH + 20,
    top: box.y + box.h - 22,
  };
}

function yAxis(s: Sheet, p: Plot, scale: { min: number; max: number; step: number }) {
  const toY = (v: number) =>
    p.bottom + ((v - scale.min) / (scale.max - scale.min)) * (p.top - p.bottom);
  const decimals = scale.step < 1 ? 1 : 0;
  for (let v = scale.min; v <= scale.max + scale.step / 1000; v += scale.step) {
    const y = toY(v);
    s.page.drawLine({
      start: { x: p.left, y },
      end: { x: p.right, y },
      thickness: 0.4,
      color: GRID,
    });
    s.text(formatValue(v, decimals), p.left - 32, y - 3, {
      size: 7,
      color: MUTED,
      align: "right",
      width: 28,
    });
  }
  s.page.drawLine({
    start: { x: p.left, y: p.bottom },
    end: { x: p.right, y: p.bottom },
    thickness: 0.7,
    color: MUTED,
  });
  s.page.drawLine({
    start: { x: p.left, y: p.bottom },
    end: { x: p.left, y: p.top },
    thickness: 0.7,
    color: MUTED,
  });
  return toY;
}

function xLabels(s: Sheet, p: Plot, categories: string[], xOf: (i: number) => number) {
  const stride = labelStride(categories.length, Math.max(2, Math.floor((p.right - p.left) / 30)));
  categories.forEach((c, i) => {
    if (i % stride !== 0 && i !== categories.length - 1) return;
    const x = xOf(i);
    s.page.drawLine({
      start: { x, y: p.bottom },
      end: { x, y: p.bottom - 3 },
      thickness: 0.6,
      color: MUTED,
    });
    s.text(c, x - 15, p.bottom - 12, { size: 7, color: INK, align: "center", width: 30 });
  });
}

/**
 * Value labels for one category, nudged apart vertically so three series that
 * land on nearly the same figure (temperature 69, GPP 67 on the same day) do
 * not print on top of each other.
 */
function placeLabels(
  s: Sheet,
  items: { x: number; y: number; text: string; color: RGB }[],
  top: number,
) {
  // Highest point first. Each label sits just above its marker when there is
  // room, otherwise just below it, and never within 7pt of the one above.
  const sorted = [...items].sort((a, b) => b.y - a.y);
  let ceiling = top + 14;
  for (const it of sorted) {
    let ly = Math.min(it.y + 4, ceiling - 7);
    if (ly < it.y + 3) ly = Math.min(it.y - 9, ceiling - 7);
    ceiling = ly;
    s.text(it.text, it.x - 15, ly, { size: 6.5, color: it.color, align: "center", width: 30 });
  }
}

export function drawLineChart(
  s: Sheet,
  box: Box,
  opts: {
    title: string;
    categories: string[];
    series: LineSeries[];
    refLines?: RefLine[];
    /** Print a value beside each marker (thinned out on a long job). */
    labels?: boolean;
  },
) {
  const legend = [
    ...opts.series.map((x) => ({ name: x.name, color: x.color })),
    ...(opts.refLines ?? [])
      .filter((r) => r.label)
      .map((r) => ({ name: r.label!, color: r.color, dashed: true })),
  ];
  const p = frame(s, box, opts.title, legend);
  const values = [
    ...opts.series.flatMap((x) => x.values.filter((v): v is number => v != null)),
    ...(opts.refLines ?? []).map((r) => r.value),
  ];
  const scale = niceScale(Math.min(...values), Math.max(...values));
  const toY = yAxis(s, p, scale);
  const n = opts.categories.length;
  const xOf = (i: number) =>
    n <= 1 ? (p.left + p.right) / 2 : p.left + 10 + (i * (p.right - p.left - 20)) / (n - 1);
  xLabels(s, p, opts.categories, xOf);

  for (const r of opts.refLines ?? []) {
    const y = toY(r.value);
    s.page.drawLine({
      start: { x: xOf(0), y },
      end: { x: xOf(Math.max(0, n - 1)), y },
      thickness: 1,
      color: r.color,
      dashArray: [3, 2],
    });
  }

  const labelStrideN = labelStride(n, Math.max(2, Math.floor((p.right - p.left) / 26)));
  const labelsAt = new Map<number, { x: number; y: number; text: string; color: RGB }[]>();

  for (const x of opts.series) {
    let prev: { i: number; v: number } | null = null;
    x.values.forEach((v, i) => {
      if (v == null) return;
      if (prev) {
        const gap = i - prev.i > 1;
        s.page.drawLine({
          start: { x: xOf(prev.i), y: toY(prev.v) },
          end: { x: xOf(i), y: toY(v) },
          thickness: gap ? 0.7 : 1.3,
          color: x.color,
          dashArray: gap ? [1.5, 2] : undefined,
        });
      }
      prev = { i, v };
    });
    x.values.forEach((v, i) => {
      if (v == null) return;
      const hollow = x.hollow?.[i] ?? false;
      s.page.drawCircle({
        x: xOf(i),
        y: toY(v),
        size: 2.2,
        color: hollow ? WHITE : x.color,
        borderColor: x.color,
        borderWidth: hollow ? 0.9 : 0,
      });
      if (opts.labels !== false && (i % labelStrideN === 0 || i === n - 1)) {
        const list = labelsAt.get(i) ?? [];
        list.push({ x: xOf(i), y: toY(v), text: formatValue(v, x.decimals ?? 0), color: x.color });
        labelsAt.set(i, list);
      }
    });
  }
  for (const items of labelsAt.values()) placeLabels(s, items, p.top);
}

export function drawBarChart(
  s: Sheet,
  box: Box,
  opts: { title: string; categories: string[]; series: BarSeries[] },
) {
  const p = frame(
    s,
    box,
    opts.title,
    opts.series.map((x) => ({ name: x.name, color: x.color })),
  );
  const max = Math.max(1, ...opts.series.flatMap((x) => x.values));
  const scale = niceScale(0, max);
  // Equipment is counted in whole units; a 2.5 tick would be a half a dehumidifier.
  if (scale.step < 1) {
    scale.step = 1;
    scale.max = Math.max(1, Math.ceil(max));
  } else {
    scale.step = Math.ceil(scale.step);
    scale.max = Math.ceil(scale.max / scale.step) * scale.step;
  }
  scale.min = 0;
  const toY = yAxis(s, p, scale);
  const n = Math.max(1, opts.categories.length);
  const slot = (p.right - p.left) / n;
  const group = slot * 0.8;
  const barW = group / Math.max(1, opts.series.length);
  const xOf = (i: number) => p.left + slot * i + slot / 2;
  xLabels(s, p, opts.categories, xOf);
  const showValues = barW >= 7;
  opts.series.forEach((x, si) => {
    x.values.forEach((v, i) => {
      if (!v) return;
      const bx = xOf(i) - group / 2 + si * barW;
      const top = toY(v);
      s.page.drawRectangle({
        x: bx,
        y: p.bottom,
        width: Math.max(0.5, barW - 0.6),
        height: top - p.bottom,
        color: x.color,
      });
      if (showValues)
        s.text(String(v), bx - 10, top + 2, {
          size: 6.5,
          color: INK,
          align: "center",
          width: barW + 20,
        });
    });
  });
}

/** An empty chart frame with a sentence in it — "no outside readings on file". */
export function drawChartPlaceholder(s: Sheet, box: Box, title: string, sentence: string) {
  s.text(title, box.x, box.y + box.h - 11, { size: 10, bold: true, align: "center", width: box.w });
  s.box(box.x + 20, box.y + 10, box.w - 40, box.h - 34, undefined, LINE);
  s.text(sentence, box.x + 20, box.y + box.h / 2 - 10, {
    size: 9,
    color: MUTED,
    align: "center",
    width: box.w - 40,
  });
}
