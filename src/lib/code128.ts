/**
 * A Code 128 decoder, written here rather than installed.
 *
 * Gold Star's asset plates are Code 128. Chrome on Android decodes them
 * natively through `BarcodeDetector`; Safari on iOS has no such API and never
 * will on the company's timescale, and half a restoration crew is on iPhones.
 * The alternative to these ~250 lines is ~300KB of ZXing loaded on exactly the
 * phones with the worst connection, so the symbology is implemented directly.
 *
 * It is deliberately narrow: one horizontal scanline at a time, no rotation
 * search, no perspective correction. That is enough for a riveted metal plate
 * held square at 100mm, and it is backed by two independent guards before a
 * read is believed — the modulo-103 checksum and the caller's tag format. (A
 * third, the same value read twice in a row, was dropped on 13 Oct to make the
 * equipment scanner as quick as Supplies › Scan out.) Anything less certain is
 * reported as "could not read", never as a wrong unit.
 */

/**
 * The 108 symbol patterns as element widths, bar first, in modules.
 * Values 0-102 are data, 103-105 the start codes, 106 the stop code.
 */
// prettier-ignore — one symbol per line would be 107 lines of noise; the grid
// is what makes a transcription error visible to a reviewer.
// prettier-ignore
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312",
  "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222",
  "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131",
  "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321",
  "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121",
  "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321",
  "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224",
  "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114",
  "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112",
  "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113",
  "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412",
  "211214", "211232", "2331112",
] as const;

export const CODE128_PATTERNS: readonly string[] = PATTERNS;

const START_A = 103;
const START_B = 104;
const START_C = 105;
const STOP = 106;

/** Pattern string → symbol value, for O(1) lookup of a rounded run group. */
const BY_PATTERN = new Map<string, number>();
for (let v = 0; v < PATTERNS.length; v += 1) BY_PATTERN.set(PATTERNS[v]!, v);

type Set128 = "A" | "B" | "C";

/**
 * Symbol value → text, given the active character set. Returns null for the
 * control values (shift, set switches, FNC) which the caller handles itself.
 */
function symbolText(value: number, set: Set128): string | null {
  if (set === "C") return value <= 99 ? String(value).padStart(2, "0") : null;
  if (value > 95) return null;
  if (set === "B") return String.fromCharCode(value + 32);
  // Set A: 0-63 are the printable half, 64-95 are the ASCII control block.
  return value <= 63 ? String.fromCharCode(value + 32) : String.fromCharCode(value - 64);
}

/**
 * Run lengths of alternating dark/light elements, starting with a dark one at
 * `start`, turned into a symbol value — or null when the widths do not round
 * to a legal 11-module (13 for stop) pattern.
 */
function readSymbol(runs: number[], start: number, elements: number): number | null {
  let total = 0;
  for (let i = 0; i < elements; i += 1) {
    const run = runs[start + i];
    if (run === undefined || run <= 0) return null;
    total += run;
  }
  const modules = elements === 7 ? 13 : 11;
  const unit = total / modules;
  // A bar narrower than about a third of a module is noise, not a symbol.
  if (unit < 0.6) return null;

  let key = "";
  let sum = 0;
  for (let i = 0; i < elements; i += 1) {
    const w = Math.round(runs[start + i]! / unit);
    if (w < 1 || w > 4) return null;
    sum += w;
    key += String(w);
  }
  if (sum !== modules) return null;
  const value = BY_PATTERN.get(key);
  return value === undefined ? null : value;
}

/**
 * Symbol values (start character excluded, check character excluded) → text.
 * Null when the stream asks for something this decoder does not implement,
 * which is treated as an unreadable barcode rather than a partial guess.
 */
function interpret(startValue: number, values: number[]): string | null {
  let set: Set128 = startValue === START_A ? "A" : startValue === START_B ? "B" : "C";
  /** A shift moves one single character into the other set, then reverts. */
  let shifted: Set128 | null = null;
  let out = "";

  for (const value of values) {
    if (value === 102) continue; // FNC1 — separator, no text
    if (set === "C") {
      if (value === 100) {
        set = "B";
        continue;
      }
      if (value === 101) {
        set = "A";
        continue;
      }
    } else {
      if (value === 96 || value === 97) continue; // FNC3 / FNC2
      if (value === 98) {
        shifted = set === "A" ? "B" : "A";
        continue;
      }
      if (value === 99) {
        set = "C";
        continue;
      }
      // 100 latches to B from A and is FNC4 in B; 101 is the mirror image.
      if (value === 100) {
        if (set === "A") set = "B";
        continue;
      }
      if (value === 101) {
        if (set === "B") set = "A";
        continue;
      }
    }
    const text = symbolText(value, shifted ?? set);
    shifted = null;
    if (text === null) return null;
    out += text;
  }
  return out;
}

/**
 * Decode one run-length-encoded scanline. `runs` alternates dark, light, dark…
 * beginning with dark. Returns the decoded text or null.
 *
 * Kept separate from any pixel handling so it is testable without a canvas —
 * a decoder nobody can test against known bytes is a decoder nobody can trust.
 */
export function decodeCode128Runs(runs: number[]): string | null {
  return decodeCode128RunsDetailed(runs).text;
}

/**
 * How far a scanline got before it failed — the breadcrumb a field report
 * needs. In order of progress: no start character anywhere; a start but no
 * stop; a start and a stop whose check character did not match; a checksum
 * that passed but asked for a character set this decoder does not implement.
 */
export type Code128Stage = "no_start" | "no_stop" | "checksum" | "charset" | "decoded";

const STAGE_RANK: Record<Code128Stage, number> = {
  no_start: 0,
  no_stop: 1,
  checksum: 2,
  charset: 3,
  decoded: 4,
};

/** The further of two stages. */
export function furtherStage(a: Code128Stage, b: Code128Stage): Code128Stage {
  return STAGE_RANK[b] > STAGE_RANK[a] ? b : a;
}

/** `decodeCode128Runs`, saying how far it got when it fails. */
export function decodeCode128RunsDetailed(runs: number[]): {
  text: string | null;
  stage: Code128Stage;
} {
  let stage: Code128Stage = "no_start";
  for (let start = 0; start + 6 < runs.length; start += 1) {
    const startValue = readSymbol(runs, start, 6);
    if (startValue !== START_A && startValue !== START_B && startValue !== START_C) continue;
    stage = furtherStage(stage, "no_stop");

    const values: number[] = [];
    let cursor = start + 6;
    let stopped = false;
    // 60 symbols is far past any asset tag; past it the scanline is noise.
    while (values.length <= 60) {
      // The stop code is 7 elements, so it is tried before the 6-element read
      // that would otherwise consume its first six and desynchronise.
      if (readSymbol(runs, cursor, 7) === STOP) {
        stopped = true;
        break;
      }
      const value = readSymbol(runs, cursor, 6);
      if (value === null) break;
      values.push(value);
      cursor += 6;
    }
    // The last symbol before stop is the modulo-103 check character.
    if (!stopped || values.length < 1) continue;
    stage = furtherStage(stage, "checksum");
    const check = values.pop()!;
    let sum = startValue;
    for (let i = 0; i < values.length; i += 1) sum += (i + 1) * values[i]!;
    if (sum % 103 !== check) continue;
    stage = furtherStage(stage, "charset");

    const text = interpret(startValue, values);
    if (text) return { text, stage: "decoded" };
  }
  return { text: null, stage };
}

/** Under this spread the "barcode" is a shadow on a wall, not a plate. */
const MIN_CONTRAST = 40;

/**
 * Run lengths from a threshold, shared by both thresholds below so the two
 * can never disagree about where a run starts.
 *
 * Edges are placed to a fraction of a pixel (22 Oct): where a row crosses the
 * threshold between two samples, the crossing is interpolated rather than
 * snapped to the next whole pixel. On a plate at two pixels a module, snapping
 * moves an edge by up to half a module, and the per-symbol rounding then reads
 * a 1 as a 2 — the "too far away / at an angle" misses from the field. The
 * runs are fractional; readSymbol only ever divides and rounds them.
 */
function runsFromThreshold(
  row: ArrayLike<number>,
  thresholdAt: (i: number) => number,
): number[] | null {
  const n = row.length;
  const runs: number[] = [];
  let dark = row[0]! < thresholdAt(0);
  let edge = 0; // where the current run began, in fractional pixels
  for (let i = 1; i < n; i += 1) {
    const t = thresholdAt(i);
    const isDark = row[i]! < t;
    if (isDark === dark) continue;
    const a = row[i - 1]! - thresholdAt(i - 1);
    const b = row[i]! - t;
    const f = a === b ? 0.5 : Math.min(1, Math.max(0, a / (a - b)));
    const at = i - 1 + f;
    // The leading light run is the quiet zone and is dropped, so `runs`
    // always starts dark, which is what decodeCode128Runs expects.
    if (dark || runs.length > 0) runs.push(at - edge);
    dark = isDark;
    edge = at;
  }
  if (dark) runs.push(n - edge);
  return runs.length >= 7 ? runs : null;
}

/** The row's own min and max, and whether there is enough spread to bother. */
function contrast(row: ArrayLike<number>): { min: number; max: number } | null {
  let min = 255;
  let max = 0;
  for (let i = 0; i < row.length; i += 1) {
    const v = row[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min < MIN_CONTRAST ? null : { min, max };
}

/**
 * Turn one row of luminance samples into run lengths, or null when the row has
 * too little contrast to be a barcode at all. The threshold is the midpoint of
 * the row's own range, so a dim basement and a headlamp both work.
 */
export function runsFromLuminance(row: ArrayLike<number>): number[] | null {
  const n = row.length;
  if (n < 24) return null;
  const range = contrast(row);
  if (!range) return null;
  const threshold = (range.min + range.max) / 2;
  return runsFromThreshold(row, () => threshold);
}

/**
 * How much of the row each pixel is judged against, as a fraction of its
 * length. Wide enough to hold several bars — a window narrower than one bar
 * sees a bar as its own background and every pixel comes out light.
 */
const LOCAL_WINDOW_FRACTION = 1 / 8;

/** The shortest useful window, for a narrow crop. */
const LOCAL_WINDOW_MIN = 15;

/**
 * How far under the local mean a pixel has to sit to count as a bar. A few
 * percent, because a barcode's own window is roughly half bars and the mean
 * therefore lands between the two levels already; the bias only stops a flat
 * patch of noise from being cut in half and read as stripes.
 */
const LOCAL_BIAS = 0.06;

/**
 * The same row, thresholded against its own neighbourhood instead of its
 * global midpoint.
 *
 * This is the basement: a headlamp puts a hot spot on one end of a plate and
 * leaves the other in shadow, and glare off riveted metal does the same across
 * three bars. One midpoint for the whole row then reads the lit half as all
 * white and the shadowed half as all black, and a plate a person can see
 * perfectly well does not decode. A sliding local mean has no single midpoint
 * to get wrong — each pixel is compared with the inch of plate around it.
 *
 * It is the second pass, not the first: the global threshold is cheaper and is
 * correct on an evenly lit plate, which is most of them.
 */
export function runsFromLuminanceLocal(row: ArrayLike<number>, window?: number): number[] | null {
  const n = row.length;
  if (n < 24) return null;
  // Still refused when the WHOLE row is flat: a local threshold on a blank
  // wall would happily find stripes in the sensor noise.
  if (!contrast(row)) return null;

  const raw = window ?? Math.round(n * LOCAL_WINDOW_FRACTION);
  const w = Math.max(LOCAL_WINDOW_MIN, raw);
  const half = w >> 1;

  // Prefix sums, so the window mean is two lookups per pixel rather than w of
  // them. This runs 21 times a frame at 8 frames a second on a phone.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i += 1) prefix[i + 1] = prefix[i]! + row[i]!;

  return runsFromThreshold(row, (i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const mean = (prefix[hi + 1]! - prefix[lo]!) / (hi - lo + 1);
    return mean * (1 - LOCAL_BIAS);
  });
}

/**
 * The fewest runs a Code 128 symbol can have: start (6) + one data or check
 * character (6) + stop (7), and the check character makes it two symbols —
 * 25. A line with fewer edges cannot be a barcode, and skipping it before the
 * symbol search is what makes scanning the whole frame affordable.
 */
export const MIN_CODE128_RUNS = 25;

/** Why a row did not decode — or that it did. */
export type RowOutcome = "flat" | "few_edges" | Code128Stage;

/**
 * Best effort on one scanline, both ways round — a plate read upside down is
 * the same symbol reversed, and a crew is not going to rotate the phone twice.
 *
 * Two thresholds, in cost order. Every read still has to clear the modulo-103
 * checksum, so the second pass buys tolerance without buying guesses: a row
 * the local threshold turns into plausible-looking noise fails the check
 * character exactly as it did before.
 */
export function decodeCode128Row(row: ArrayLike<number>): string | null {
  return decodeCode128RowDetailed(row).text;
}

/** `decodeCode128Row`, saying how far the row got. */
export function decodeCode128RowDetailed(row: ArrayLike<number>): {
  text: string | null;
  outcome: RowOutcome;
} {
  if (row.length < 24) return { text: null, outcome: "few_edges" };
  if (!contrast(row)) return { text: null, outcome: "flat" };
  let best: Code128Stage | null = null;
  // The local threshold runs only when the global one did not decode.
  for (const make of [runsFromLuminance, runsFromLuminanceLocal]) {
    const runs = make(row);
    if (!runs || runs.length < MIN_CODE128_RUNS) continue;
    const forward = decodeCode128RunsDetailed(runs);
    if (forward.text) return { text: forward.text, outcome: "decoded" };
    const backward = decodeCode128RunsDetailed([...runs].reverse());
    if (backward.text) return { text: backward.text, outcome: "decoded" };
    const stage = furtherStage(forward.stage, backward.stage);
    best = best === null ? stage : furtherStage(best, stage);
  }
  return { text: null, outcome: best ?? "few_edges" };
}
