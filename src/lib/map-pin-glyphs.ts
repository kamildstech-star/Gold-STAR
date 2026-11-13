/**
 * The little picture inside a Field map pin. Mark, on the Routes map:
 *
 *   "add little logos to each one to indicate what it is, and a hammer for
 *    jobs for example"
 *
 * The pins are Google `Marker`s with a circle symbol, and a symbol cannot
 * hold a second shape — so a pin with a glyph is drawn as an SVG data URI
 * instead: the same circle in the same colour with the same white ring, and
 * the glyph in the middle. The glyphs are lucide's own paths (the icons the
 * rest of the app draws with) so the pin, the legend chip and the row under
 * the map all show the same picture:
 *
 *   deal    Handshake   — what the "In this view" rows already use
 *   client  Building2   — likewise
 *   job     Hammer      — Mark's example
 *   visit   Footprints  — where someone has been
 *   office  Building
 *
 * A pin carrying text (a route rank, a cluster count) keeps the plain circle:
 * the number is the label there and a glyph under it would be noise.
 */

export type PinGlyph = "deal" | "client" | "job" | "visit" | "office";

/* lucide 0.575 path data, 24×24, stroke-drawn. */
const GLYPH_PATHS: Record<PinGlyph, string[]> = {
  deal: [
    "m11 17 2 2a1 1 0 1 0 3-3",
    "m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4",
    "m21 3 1 11h-2",
    "M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3",
    "M3 4h8",
  ],
  client: [
    "M10 12h4",
    "M10 8h4",
    "M14 21v-3a2 2 0 0 0-4 0v3",
    "M6 10H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2",
    "M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16",
  ],
  job: [
    "m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9",
    "m18 15 4-4",
    "m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5",
  ],
  visit: [
    "M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z",
    "M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z",
    "M16 17h4",
    "M4 13h4",
  ],
  office: [
    "M12 10h.01",
    "M12 14h.01",
    "M12 6h.01",
    "M16 10h.01",
    "M16 14h.01",
    "M16 6h.01",
    "M8 10h.01",
    "M8 14h.01",
    "M8 6h.01",
    "M9 22v-3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3",
    "M4 2h16a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
  ],
};

export type PinGlyphSpec = {
  glyph: PinGlyph;
  /** Fill of the circle — or its ring, when hollow. */
  color: string;
  /** Radius in px, the same number a plain circle pin uses as `scale`. */
  radius: number;
  /** White circle with the colour as ring and glyph — a closed job. */
  hollow?: boolean;
  /** The thick card-coloured ring an active pin wears. */
  active?: boolean;
};

/** The SVG markup for one pin, sized to its diameter. Pure, so it can be tested. */
export function pinGlyphSvg(spec: PinGlyphSpec): string {
  const r = spec.radius;
  const d = r * 2;
  const ring = spec.active ? 3 : spec.hollow ? 2.5 : 2;
  const fill = spec.hollow ? "#FFFFFF" : spec.color;
  const stroke = spec.hollow ? spec.color : spec.active ? "#FFFFFF" : "rgba(255,255,255,0.9)";
  const ink = spec.hollow ? spec.color : "#FFFFFF";
  // The glyph takes a little over half the diameter — lucide's shapes fill
  // their 24-box edge to edge, so any more than this touches the ring.
  const g = d * 0.58;
  const scale = g / 24;
  const off = r - g / 2;
  const paths = GLYPH_PATHS[spec.glyph].map((p) => `<path d="${p}"/>`).join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">` +
    `<circle cx="${r}" cy="${r}" r="${r - ring / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${ring}"/>` +
    `<g transform="translate(${off} ${off}) scale(${scale})" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${paths}</g>` +
    `</svg>`
  );
}

const uriCache = new Map<string, string>();

/** The same SVG as a data URI for a Google `Icon`, memoised per spec. */
export function pinGlyphDataUri(spec: PinGlyphSpec): string {
  const key = `${spec.glyph}|${spec.color}|${spec.radius}|${spec.hollow ? 1 : 0}|${spec.active ? 1 : 0}`;
  let uri = uriCache.get(key);
  if (!uri) {
    uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pinGlyphSvg(spec))}`;
    uriCache.set(key, uri);
  }
  return uri;
}
