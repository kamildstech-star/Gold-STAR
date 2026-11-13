/**
 * Reading a tape measure the way a crew types it.
 *
 * Nobody standing in a room with a tape converts 12 feet 6 inches to 12.5
 * before typing it, so a length box takes whatever they write: `12'6"`,
 * `12' 6`, `12-6`, `12 6`, `12.5`, `12ft 6in`, `150"`, `12 6 1/2`. A door
 * width box reads inches the same way: `32`, `30 1/2`, `2'8"`, `2-8`.
 *
 * Adapted from the standalone Field Capture package's `units.ts`. Kept:
 * the shapes it accepts. Changed, each because the original quietly stored a
 * wrong number:
 *   - inches of 12 or more after a feet figure are refused, not added
 *     (`12 66` is a typo for `12 6`, not 17' 6");
 *   - fractions of an inch are read (`6 1/2`, `6½`) — tapes are marked in
 *     sixteenths and a crew reads the mark they see;
 *   - a bare "whole and a fraction" in a feet box is feet (`12 1/2` is
 *     twelve and a half feet, which is how it is said aloud);
 *   - curly quotes and primes from a phone keyboard count as ' and ".
 *
 * Pure: no React, no clock, no Supabase. `null` means "could not read that",
 * which the field shows in red rather than storing a guess.
 */

/** Feet are kept to 1/10000 ft (well under 1/16"), inches to 1/1000". */
const roundTo = (v: number, places: number) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};

const UNICODE_FRACTIONS: Record<string, string> = {
  "½": " 1/2",
  "¼": " 1/4",
  "¾": " 3/4",
  "⅛": " 1/8",
  "⅜": " 3/8",
  "⅝": " 5/8",
  "⅞": " 7/8",
};

/**
 * One spelling for every way a phone writes a foot or an inch mark. Words
 * become marks (`12ft 6in` → `12'6"`), two apostrophes become a double
 * quote, and runs of spaces collapse — so the patterns below only ever see
 * digits, `.`, `/`, `-`, `'`, `"` and single spaces.
 */
function normalize(input: string): string {
  let s = input.trim().toLowerCase();
  for (const [glyph, text] of Object.entries(UNICODE_FRACTIONS)) s = s.split(glyph).join(text);
  return s
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]/g, '"')
    .replace(/''/g, '"')
    .replace(/\s*(?:feet|foot|ft)\.?/g, "'")
    .replace(/\s*(?:inches|inch|in)\.?/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const NUM = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
/** Inches: a whole or decimal figure, a fraction, or both ("6", "6.5", "1/2", "6 1/2", "6-1/2"). */
const INCHES = String.raw`(?:(\d+(?:\.\d+)?)(?:[ -](\d+)\/(\d+))?|(\d+)\/(\d+))`;

const BARE = new RegExp(`^${NUM}$`);
const FEET_MARKED = new RegExp(`^${NUM}'$`);
const INCHES_ONLY = new RegExp(`^${INCHES}"?$`);
const INCHES_MARKED = new RegExp(`^${INCHES}"$`);
const FEET_AND_FRACTION = /^(\d+)[ -](\d+)\/(\d+)'?$/;
const FEET_INCHES = new RegExp(`^(\\d+(?:\\.\\d+)?) ?(?:'|-| ) ?${INCHES}"?$`);

/** The inch figure out of an {@link INCHES} match starting at `at`, or null. */
function inchesFrom(m: RegExpMatchArray, at: number): number | null {
  const whole = m[at];
  const num = m[at + 1] ?? m[at + 3];
  const den = m[at + 2] ?? m[at + 4];
  let total = whole != null ? Number(whole) : 0;
  if (num != null && den != null) {
    const d = Number(den);
    if (!d) return null;
    total += Number(num) / d;
  }
  if (whole == null && num == null) return null;
  return Number.isFinite(total) ? total : null;
}

/**
 * A length in feet. Bare numbers are feet (`12.5`), a lone inch figure is
 * converted (`150"` → 12.5), and feet-and-inches in any of the tape shapes.
 */
export function parseFeet(input: string): number | null {
  const s = normalize(input);
  if (!s) return null;

  const bare = s.match(BARE) ?? s.match(FEET_MARKED);
  if (bare) return roundTo(Number(bare[1]), 4);

  const inchesOnly = s.match(INCHES_MARKED);
  if (inchesOnly) {
    const inches = inchesFrom(inchesOnly, 1);
    return inches == null ? null : roundTo(inches / 12, 4);
  }

  const fraction = s.match(FEET_AND_FRACTION);
  if (fraction) {
    const den = Number(fraction[3]);
    if (!den) return null;
    return roundTo(Number(fraction[1]) + Number(fraction[2]) / den, 4);
  }

  const ftIn = s.match(FEET_INCHES);
  if (ftIn) {
    const inches = inchesFrom(ftIn, 2);
    if (inches == null || inches >= 12) return null;
    return roundTo(Number(ftIn[1]) + inches / 12, 4);
  }
  return null;
}

/**
 * A width in inches — doors and windows. Bare numbers are inches (`32`),
 * fractions are read (`30 1/2`), and feet-and-inches convert (`2'8"` → 32).
 */
export function parseInches(input: string): number | null {
  const s = normalize(input);
  if (!s) return null;

  const inchesOnly = s.match(INCHES_ONLY);
  if (inchesOnly) {
    const inches = inchesFrom(inchesOnly, 1);
    return inches == null ? null : roundTo(inches, 3);
  }

  const feet = s.match(FEET_MARKED);
  if (feet) return roundTo(Number(feet[1]) * 12, 3);

  const ftIn = s.match(FEET_INCHES);
  if (ftIn) {
    const inches = inchesFrom(ftIn, 2);
    if (inches == null || inches >= 12) return null;
    return roundTo(Number(ftIn[1]) * 12 + inches, 3);
  }
  return null;
}

const EIGHTHS = ["", "⅛", "¼", "⅜", "½", "⅝", "¾", "⅞"];

/** Inches to the nearest eighth, as the tape shows them: `6`, `6½`, `⅜`. */
function inchText(eighths: number): string {
  const whole = Math.floor(eighths / 8);
  const frac = EIGHTHS[eighths % 8]!;
  if (!whole) return frac || "0";
  return `${whole}${frac}`;
}

/**
 * 12.5 → `12' 6"`, 12 → `12'`, 0.5 → `6"`. Shown back in the box after a
 * value is read, so the crew sees what was understood in the units they
 * measured in. Nearest eighth of an inch.
 */
export function formatFeet(ft: number | null | undefined): string {
  if (ft == null || !Number.isFinite(ft)) return "";
  const sign = ft < 0 ? "-" : "";
  const eighths = Math.round(Math.abs(ft) * 96);
  const feet = Math.floor(eighths / 96);
  const rest = eighths - feet * 96;
  if (!feet) return `${sign}${inchText(rest)}"`;
  return rest ? `${sign}${feet}' ${inchText(rest)}"` : `${sign}${feet}'`;
}

/** 32 → `32"`, 30.5 → `30½"`. Nearest eighth. */
export function formatInches(inches: number | null | undefined): string {
  if (inches == null || !Number.isFinite(inches)) return "";
  return `${inchText(Math.round(Math.abs(inches) * 8))}"`;
}
