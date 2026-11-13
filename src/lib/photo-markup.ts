/**
 * Photo markup: the shape, and how to read it back out of jsonb.
 *
 * Split out of `job-photos.ts` because two very different callers need it and
 * only one of them may touch a Supabase client. The public share viewer runs
 * for someone with no login, and the server function that feeds it strips
 * markup the link does not permit — neither can afford to import the module
 * that carries the authenticated browser client.
 *
 * Markup is vector and lives in its own table. The photograph on the shelf is
 * claim evidence and is never re-flattened, which is the only reason a share
 * link can offer to hide markup at all.
 */

/**
 * Points are fractions of the image's natural width and height, so the same
 * circle lands in the same place on a phone and on a 4K monitor.
 */
export type PhotoStroke = { color: string; width: number; points: [number, number][] };

/**
 * A placed label. `size` is a fraction of the image width, the same currency as
 * a stroke width — a size in pixels would be a headline on the desktop that
 * wrote it and a speck on the phone that reads it.
 */
export type PhotoText = { x: number; y: number; text: string; color: string; size: number };

/** What the tools edit and what one undo step snapshots: pen and text together. */
export type PhotoMarkupDoc = { strokes: PhotoStroke[]; texts: PhotoText[] };

export const ANNOTATION_VERSION = 1;

/** Hand-rolled because the column is `jsonb` — anything could be in there. */
export function parseStrokes(json: unknown): PhotoStroke[] {
  const strokes = (json as { strokes?: unknown } | null)?.strokes;
  if (!Array.isArray(strokes)) return [];
  return strokes.flatMap((s) => {
    const raw = s as Partial<PhotoStroke>;
    const points = Array.isArray(raw.points)
      ? raw.points.filter(
          (p): p is [number, number] =>
            Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"),
        )
      : [];
    if (points.length === 0) return [];
    return [
      {
        color: typeof raw.color === "string" ? raw.color : "#FACC15",
        width: typeof raw.width === "number" ? raw.width : 0.006,
        points,
      },
    ];
  });
}

export function parseTexts(json: unknown): PhotoText[] {
  const texts = (json as { texts?: unknown } | null)?.texts;
  // Absent, not empty, on every row written before labels existed.
  if (!Array.isArray(texts)) return [];
  return texts.flatMap((t) => {
    const raw = t as Partial<PhotoText>;
    if (typeof raw.x !== "number" || typeof raw.y !== "number") return [];
    if (typeof raw.text !== "string" || raw.text.trim() === "") return [];
    return [
      {
        x: raw.x,
        y: raw.y,
        text: raw.text,
        color: typeof raw.color === "string" ? raw.color : "#FACC15",
        size: typeof raw.size === "number" ? raw.size : 0.055,
      },
    ];
  });
}

export function parseMarkupDoc(json: unknown): PhotoMarkupDoc {
  return { strokes: parseStrokes(json), texts: parseTexts(json) };
}

export function markupIsEmpty(doc: PhotoMarkupDoc): boolean {
  return doc.strokes.length === 0 && doc.texts.length === 0;
}
