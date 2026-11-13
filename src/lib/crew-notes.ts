/**
 * A crew's shorthand, turned into a sentence a carrier can read.
 *
 * Mark, 13 Oct, on a generated loss report: the field updates pasted the
 * crew's note straight in — "Temps IN: 9:50AM Lunch 1 hour out: 4:30pm
 * unit/3414-3412-3413-3315-…". The facts in that note are good; the shape is a
 * text message. This pulls out what the shorthand always carries — who, time
 * in, time out, lunch, which units — and writes it as one sentence:
 *
 *   "Temporary crew on site 9:50 AM–4:30 PM with a one-hour lunch; units 3315
 *    and 3412–3414."
 *
 * Nothing is computed that the note did not say: no hours worked are derived
 * from the times (the labour figures have their own, deduplicated source), and
 * a unit range is only ever written over units that are all in the note.
 * Whatever the parser does not recognise is kept, tidied, as a second
 * sentence — a note is never shortened by losing words.
 *
 * Pure, so every shape a crew writes can be a unit test.
 */

export type ParsedCrewNote = {
  /** "Temporary crew", "Crew" — only when the note named one. */
  crew: string | null;
  /** "9:50 AM" */
  timeIn: string | null;
  timeOut: string | null;
  /** "one-hour", "30-minute", "no" */
  lunch: string | null;
  /** Every unit the note listed, sorted, duplicates dropped. */
  units: string[];
  /** Whatever was left over, as written (whitespace tidied). */
  rest: string;
};

const TIME = String.raw`(\d{1,2}:\d{2}\s*(?:[ap]\.?\s?m\.?)?|\d{1,2}\s*[ap]\.?\s?m\.?)`;
const IN_RE = new RegExp(
  String.raw`\b(?:time\s*in|in|start(?:ed)?|arriv(?:ed|al)|on\s*site)\b\s*(?:at\s*)?[:\-–=]?\s*${TIME}`,
  "i",
);
const OUT_RE = new RegExp(
  String.raw`\b(?:time\s*out|out|end(?:ed)?|left|finish(?:ed)?|off\s*site)\b\s*(?:at\s*)?[:\-–=]?\s*${TIME}`,
  "i",
);
const LUNCH_RE =
  /\blunch\b\s*[:\-–=]?\s*(?:(no(?:ne)?)\b|(half\s*(?:an?\s*)?hour|1\/2\s*(?:hr|hour)s?)|(\d+(?:\.\d+)?|an?|one)\s*(hours?|hrs?|h|minutes?|mins?|m)\b)/i;
const NO_LUNCH_RE = /\bno\s+lunch\b/i;
const CREW_RE = /^\s*(temps?|temporary(?:\s+crew)?|gsr(?:\s+crew)?|crew)\b\s*[:\-–]?/i;
const UNIT_RE =
  /\b(?:units?|apts?\.?|apartments?)\b\s*[/:#\-–]?\s*(#?\d{1,5}[A-Za-z]?(?:\s*(?:[-–,/&+;]|\band\b|\s)\s*#?\d{1,5}[A-Za-z]?)*)/i;

/** "9:50AM" → "9:50 AM", "4:30pm" → "4:30 PM", "10am" → "10 AM", "16:30" → "16:30". */
export function formatClock(raw: string): string {
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?$/i);
  if (!m) return raw.trim();
  const [, h, min, ap] = m;
  const clock = min ? `${Number(h)}:${min}` : String(Number(h));
  return ap ? `${clock} ${ap.toUpperCase()}M` : clock;
}

function lunchPhrase(m: RegExpMatchArray): string {
  if (m[1]) return "no";
  if (m[2]) return "half-hour";
  const n = m[3]!.toLowerCase();
  const unit = m[4]!.toLowerCase();
  const isMinutes = unit.startsWith("m");
  const amount = n === "a" || n === "an" || n === "one" ? "1" : n;
  if (!isMinutes && amount === "1") return "one-hour";
  return `${amount}-${isMinutes ? "minute" : "hour"}`;
}

function crewLabel(raw: string): string {
  return /^temp/i.test(raw) ? "Temporary crew" : "Crew";
}

const unitKey = (u: string) => {
  const m = u.match(/^(\d+)(.*)$/);
  return m ? { n: Number(m[1]), suffix: m[2]!.toUpperCase() } : { n: Infinity, suffix: u };
};

/** Units in the order a reader expects: by number, then by letter. */
export function sortUnits(units: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of units) {
    const u = raw.replace(/^#/, "").toUpperCase();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.sort((a, b) => {
    const ka = unitKey(a);
    const kb = unitKey(b);
    return ka.n - kb.n || ka.suffix.localeCompare(kb.suffix);
  });
}

/**
 * "3315 and 3412–3414". Only a run of three or more consecutive plain numbers
 * becomes a range, so a range never implies a unit the note did not list.
 */
export function unitList(units: readonly string[]): string {
  const sorted = sortUnits(units);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let j = i;
    if (/^\d+$/.test(start)) {
      while (
        j + 1 < sorted.length &&
        /^\d+$/.test(sorted[j + 1]!) &&
        Number(sorted[j + 1]) === Number(sorted[j]) + 1
      ) {
        j++;
      }
    }
    if (j - i >= 2) {
      parts.push(`${start}–${sorted[j]}`);
      i = j + 1;
    } else {
      parts.push(start);
      i += 1;
    }
  }
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Pull the structured pieces out of a note. */
export function parseCrewNote(text: string | null | undefined): ParsedCrewNote {
  let rest = (text ?? "").replace(/\s+/g, " ").trim();
  const take = (re: RegExp): RegExpMatchArray | null => {
    const m = rest.match(re);
    if (m && m.index != null) {
      rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    }
    return m;
  };

  const crewM = take(CREW_RE);
  const inM = take(IN_RE);
  const outM = take(OUT_RE);
  const lunchM = take(LUNCH_RE) ?? take(NO_LUNCH_RE);
  const unitM = take(UNIT_RE);

  const units = unitM
    ? unitM[1]!
        .split(/[^0-9A-Za-z#]+/)
        .filter((u) => u && u.toLowerCase() !== "and")
        .filter((u) => /\d/.test(u))
    : [];

  rest = rest
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:\-–/.…]+|[\s,;:\-–/…]+$/g, "")
    .trim();

  return {
    crew: crewM ? crewLabel(crewM[1]!) : null,
    timeIn: inM ? formatClock(inM[1]!) : null,
    timeOut: outM ? formatClock(outM[1]!) : null,
    lunch: lunchM ? (lunchM[0].match(/^no\s+lunch$/i) ? "no" : lunchPhrase(lunchM)) : null,
    units: sortUnits(units),
    rest,
  };
}

function sentence(s: string): string {
  const t = s.trim();
  if (!t) return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/**
 * The note as prose. A note with none of the shorthand comes back as it was
 * written, whitespace tidied — office notes are already sentences.
 */
export function cleanCrewNote(text: string | null | undefined): string {
  const raw = (text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const p = parseCrewNote(raw);
  const structured = p.timeIn || p.timeOut || p.lunch || p.units.length > 0;
  if (!structured) return raw;

  const who = p.crew ?? "Crew";
  let first = "";
  if (p.timeIn && p.timeOut) first = `${who} on site ${p.timeIn}–${p.timeOut}`;
  else if (p.timeIn) first = `${who} arrived at ${p.timeIn}`;
  else if (p.timeOut) first = `${who} left site at ${p.timeOut}`;
  if (p.lunch) {
    const lunch = p.lunch === "no" ? "no lunch break" : `a ${p.lunch} lunch`;
    first = first ? `${first} with ${lunch}` : `${who} took ${lunch}`;
  }
  if (p.units.length > 0) {
    const label = p.units.length === 1 ? "unit" : "units";
    first = first
      ? `${first}; ${label} ${unitList(p.units)}`
      : `Work in ${label} ${unitList(p.units)}`;
  }
  return [sentence(first), sentence(p.rest)].filter(Boolean).join(" ");
}
