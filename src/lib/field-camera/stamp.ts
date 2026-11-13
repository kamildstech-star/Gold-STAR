/**
 * The Field Camera's burned-in stamp: what it says, and where it goes.
 *
 * A Timemark / CompanyCam style stamp, bottom-left: a big time, the date with
 * its weekday, the address, and whichever of coordinates, job, crew member and
 * note the template asks for. It is burned into the pixels on purpose — an
 * adjuster forwarding the JPEG to a carrier forwards the stamp with it, and a
 * stamp that only exists in our database is one the carrier never sees.
 *
 * Everything here is pure: formatting takes the clock and the time zone as
 * arguments, layout takes a text-measuring function, and drawing takes a
 * context-shaped object. The camera passes a real canvas; the tests pass
 * fakes, so the layout rules are pinned without a browser.
 */

/** Every field the stamp can carry. Time and date are always the first two. */
export const STAMP_FIELDS = ["time", "date", "address", "coords", "job", "crew", "note"] as const;
export type StampField = (typeof STAMP_FIELDS)[number];

export const STAMP_FIELD_LABEL: Record<StampField, string> = {
  time: "Time",
  date: "Date & weekday",
  address: "Address",
  coords: "GPS coordinates",
  job: "Job number & name",
  crew: "Crew member",
  note: "Note",
};

export type StampTemplate = { id: string; label: string; fields: StampField[] };

/**
 * The presets. "Standard" is the default: what an adjuster asks for (when,
 * where, which job, who) without coordinates nobody reads on a thumbnail.
 */
export const STAMP_PRESETS: readonly StampTemplate[] = [
  { id: "standard", label: "Standard", fields: ["time", "date", "address", "job", "crew", "note"] },
  { id: "full", label: "Full detail", fields: [...STAMP_FIELDS] },
  { id: "minimal", label: "Time & place", fields: ["time", "date", "address"] },
  { id: "off", label: "No stamp", fields: [] },
];

export const DEFAULT_TEMPLATE: StampTemplate = STAMP_PRESETS[0]!;

/** Keep a stored or hand-built field list to known fields, in canonical order. */
export function normaliseFields(fields: readonly unknown[]): StampField[] {
  const set = new Set(
    fields.filter((f): f is StampField => STAMP_FIELDS.includes(f as StampField)),
  );
  return STAMP_FIELDS.filter((f) => set.has(f));
}

export type StampInput = {
  /** The instant of capture. */
  at: Date;
  /** IANA zone the stamp is printed in — the device's, recorded alongside. */
  timeZone: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  jobNumber: string | null;
  jobName: string | null;
  crewName: string | null;
  note: string | null;
};

export type StampText = {
  /** "2:04 PM", or null when the template leaves the time off. */
  time: string | null;
  /** The lines under it, in order: date, address, coords, job, crew, note. */
  lines: string[];
};

/** "2:04 PM" in the given zone. */
export function formatStampTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: safeZone(timeZone),
  }).format(at);
}

/** "10/14/2026 Wed" in the given zone. */
export function formatStampDate(at: Date, timeZone: string): string {
  const zone = safeZone(timeZone);
  const date = new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    timeZone: zone,
  }).format(at);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: zone }).format(at);
  return `${date} ${weekday}`;
}

/** "40.67123, -73.93841 ±8 m" — five places is about a metre. */
export function formatCoords(lat: number, lon: number, accuracyM: number | null): string {
  const base = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  return accuracyM != null && Number.isFinite(accuracyM)
    ? `${base} ±${Math.max(1, Math.round(accuracyM))} m`
    : base;
}

/** A zone Intl will not accept falls back to UTC rather than throwing on the shutter. */
function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** One line, whitespace collapsed, so a pasted note cannot push the stamp off the frame. */
function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/** What the stamp says, given the template. Pure. */
export function stampText(input: StampInput, fields: readonly StampField[]): StampText {
  const on = new Set(fields);
  const lines: string[] = [];
  if (on.has("date")) lines.push(formatStampDate(input.at, input.timeZone));
  const address = oneLine(input.address);
  if (on.has("address") && address) lines.push(address);
  if (on.has("coords") && input.lat != null && input.lon != null) {
    lines.push(formatCoords(input.lat, input.lon, input.accuracyM));
  }
  if (on.has("job")) {
    const job = [oneLine(input.jobNumber), oneLine(input.jobName)].filter(Boolean).join(" · ");
    if (job) lines.push(`Job ${job}`);
  }
  const crew = oneLine(input.crewName);
  if (on.has("crew") && crew) lines.push(crew);
  const note = oneLine(input.note);
  if (on.has("note") && note) lines.push(note.length > 140 ? `${note.slice(0, 139)}…` : note);
  return { time: on.has("time") ? formatStampTime(input.at, input.timeZone) : null, lines };
}

/* ── layout ─────────────────────────────────────────────────────────────── */

export type MeasureText = (text: string, fontPx: number, bold: boolean) => number;

export type PlacedLine = { text: string; x: number; y: number; fontPx: number; bold: boolean };

export type StampLayout = {
  /** The scrim behind the block, so white text reads on snow and on sky. */
  scrim: { x: number; y: number; w: number; h: number };
  /** The accent bar left of the detail lines, as in the reference design. */
  bar: { x: number; y: number; w: number; h: number } | null;
  lines: PlacedLine[];
  /** Shadow blur in px for the text, scaled to the frame. */
  shadowPx: number;
};

/**
 * Where everything goes on a `width` x `height` frame.
 *
 * Sized off the short edge so a portrait and a landscape shot carry the same
 * stamp, and so a 1080p preview and a 12-megapixel capture look identical,
 * just at different resolutions. Long lines wrap at word boundaries to stay
 * inside 88% of the width; a single unbreakable token (a long URL in a note)
 * is cut with an ellipsis rather than running off the edge.
 */
export function layoutStamp(
  width: number,
  height: number,
  text: StampText,
  measure: MeasureText,
): StampLayout | null {
  if (!text.time && text.lines.length === 0) return null;
  const short = Math.max(1, Math.min(width, height));
  const u = short / 100;
  const pad = Math.round(4 * u);
  const timePx = Math.max(12, Math.round(10 * u));
  const linePx = Math.max(8, Math.round(3.6 * u));
  const lineGap = Math.round(linePx * 0.35);
  const barW = Math.max(2, Math.round(0.8 * u));
  const barGap = Math.round(1.8 * u);
  const maxText = Math.max(1, width * 0.88 - pad - barW - barGap);

  const wrapped: string[] = [];
  for (const line of text.lines) wrapped.push(...wrapLine(line, linePx, maxText, measure));

  const timeH = text.time ? timePx : 0;
  const detailsH = wrapped.length ? wrapped.length * linePx + (wrapped.length - 1) * lineGap : 0;
  const between = text.time && wrapped.length ? Math.round(1.6 * u) : 0;
  const blockH = timeH + between + detailsH;

  const bottom = height - pad;
  const top = bottom - blockH;
  const x = pad;
  const lines: PlacedLine[] = [];
  // y is the baseline: canvas draws text upward from it with textBaseline "alphabetic".
  if (text.time)
    lines.push({ text: text.time, x, y: top + timePx * 0.86, fontPx: timePx, bold: true });
  const detailX = x + barW + barGap;
  let y = top + timeH + between;
  for (const t of wrapped) {
    lines.push({ text: t, x: detailX, y: y + linePx * 0.86, fontPx: linePx, bold: false });
    y += linePx + lineGap;
  }

  const widest = Math.max(
    text.time ? measure(text.time, timePx, true) : 0,
    ...wrapped.map((t) => barW + barGap + measure(t, linePx, false)),
  );
  // The scrim runs from the frame edge to a little past the widest line, and
  // a little above the block, so it reads as a soft corner, not a box.
  const scrimTop = Math.max(0, top - pad * 2);
  return {
    scrim: { x: 0, y: scrimTop, w: Math.min(width, x + widest + pad * 2), h: height - scrimTop },
    bar: wrapped.length ? { x, y: top + timeH + between, w: barW, h: detailsH } : null,
    lines,
    shadowPx: Math.max(2, Math.round(0.6 * u)),
  };
}

/** Greedy word wrap with a hard cut for a token wider than the line. */
export function wrapLine(text: string, fontPx: number, maxWidth: number, measure: MeasureText) {
  const words = text.split(" ").filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next, fontPx, false) <= maxWidth) {
      cur = next;
      continue;
    }
    if (cur) out.push(cur);
    cur = measure(word, fontPx, false) <= maxWidth ? word : cut(word, fontPx, maxWidth, measure);
  }
  if (cur) out.push(cur);
  return out;
}

function cut(word: string, fontPx: number, maxWidth: number, measure: MeasureText): string {
  let s = word;
  while (s.length > 1 && measure(`${s}…`, fontPx, false) > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

/* ── drawing ────────────────────────────────────────────────────────────── */

/** The slice of CanvasRenderingContext2D the stamp uses. */
export type StampContext = {
  font: string;
  fillStyle: string | CanvasGradient | CanvasPattern;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText(text: string): { width: number };
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
};

export const STAMP_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

export function stampFont(fontPx: number, bold: boolean): string {
  return `${bold ? "700" : "500"} ${fontPx}px ${STAMP_FONT_STACK}`;
}

/** A measure function backed by a real (or fake) context. */
export function contextMeasure(ctx: Pick<StampContext, "font" | "measureText">): MeasureText {
  return (text, fontPx, bold) => {
    ctx.font = stampFont(fontPx, bold);
    return ctx.measureText(text).width;
  };
}

/** The accent colour of the bar — the brand amber the reference design uses. */
export const STAMP_ACCENT = "#F5B301";

/** Paint a laid-out stamp. The frame must already be drawn underneath. */
export function drawStamp(ctx: StampContext, layout: StampLayout): void {
  ctx.save();
  const s = layout.scrim;
  // A diagonal fade: darkest in the corner the text sits in, clear at the
  // top-right, so the stamp never reads as a black box pasted on the photo.
  const g = ctx.createLinearGradient(s.x, s.y + s.h, s.x + s.w, s.y);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.6, "rgba(0,0,0,0.28)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(s.x, s.y, s.w, s.h);

  if (layout.bar) {
    ctx.fillStyle = STAMP_ACCENT;
    ctx.fillRect(layout.bar.x, layout.bar.y, layout.bar.w, layout.bar.h);
  }

  ctx.textBaseline = "alphabetic";
  ctx.shadowColor = "rgba(0,0,0,0.75)";
  ctx.shadowBlur = layout.shadowPx;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.max(1, Math.round(layout.shadowPx / 3));
  ctx.fillStyle = "#FFFFFF";
  for (const line of layout.lines) {
    ctx.font = stampFont(line.fontPx, line.bold);
    ctx.fillText(line.text, line.x, line.y);
  }
  ctx.restore();
}
