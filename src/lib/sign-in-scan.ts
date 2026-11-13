/**
 * Scanning a paper Crew Sign In/Out Sheet into the day's sign-in sheet (11 Nov).
 *
 * "We want to scan paper and scan all info from paper." The crew signs Gold
 * Star's paper sheet on the clipboard; the office photographs it, the vision
 * model reads every row — employee, rate code, time in, lunch, time out,
 * hotel/per diem, whether it is signed — and a person checks the rows before
 * they are added to the sheet. Signatures stay on the paper: the photo is
 * filed with the job's sign-in sheets.
 *
 * Pure: the prompt, the strict reading of the model's reply (untrusted data —
 * parsed, clamped, trimmed, never fed into another prompt), the clock (a time
 * out written "5:20" after a 9:00 start is 17:20), name matching ("Gutierrez,
 * Rose" is Rose Gutierrez) and the merge into a sheet that may already hold
 * rows signed on a phone.
 */
import type { SignInPayload, SignInRow } from "@/lib/tm-forms";

export type ScannedRow = {
  employee: string;
  /** Upper-case as written ("DL", "CCF"); checked against the catalogue by the caller. */
  rateCode: string;
  /** "HH:MM", 24-hour, or "" when the box is empty or unreadable. */
  timeIn: string;
  lunchStart: string;
  lunchEnd: string;
  timeOut: string;
  /** Anything marked in the Hotel - Per Diem box. */
  lodging: boolean;
  /** A signature (or initials) in the Signature box. */
  signed: boolean;
};

export type ScannedSheet = {
  jobName: string | null;
  jobLocation: string | null;
  /** The Date written at the top, "YYYY-MM-DD". */
  date: string | null;
  rows: ScannedRow[];
};

export const SCAN_MAX_ROWS = 80;
export const SCAN_IMAGE_MAX_DATA_URL_CHARS = 8_000_000;

export const SIGN_IN_SCAN_PROMPT = `You read Gold Star Restoration's paper "Crew Sign In/Out Sheet" from a photo and transcribe it.

Return ONLY one JSON object, no prose:
{"job_name": string|null, "job_location": string|null, "date": "YYYY-MM-DD"|null,
 "rows": [{"employee": string, "rate_code": string|null, "time_in": string|null, "lunch_start": string|null, "lunch_end": string|null, "time_out": string|null, "lodging": boolean, "signed": boolean}]}

- One entry per filled row of the table, top to bottom. Skip empty rows.
- employee: the printed or written name exactly as on the sheet, e.g. "Gutierrez, Rose".
- rate_code: the Rate Code column, e.g. "DL" or "CCF". null if empty.
- Times: write them as 24-hour "HH:MM". It is a work day: a time in is usually morning; a lunch or time out written with a smaller hour than the time in (e.g. "5:20" or "3:11" after "9:00") is in the afternoon, so 17:20 or 15:11. "5pm" is 17:00. A minute written with one digit like "9:8" is 09:08. null if the box is empty or you cannot read it.
- lodging: true if anything is written or ticked in the Hotel / Per Diem column.
- signed: true if there is a signature or initials in the Signature column for that row.
- date: the Date written at the top right, as YYYY-MM-DD (a two-digit year like 26 is 2026).
Read EVERY box on its own. Rows are different people with different times and codes: never copy a value from the row above, never fill a box because the rows around it are filled, and never assume a lunch or a time out — an empty box is null. Most crews are DL with one or two CCF; read each code as written.
Transcribe; never guess a name or a time that is not on the sheet.`;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
};

/**
 * A written time as "HH:MM", 24-hour, or "" when it is not one. Takes
 * "9:00", "09:00", "17:20", "9:8", "5pm", "5:20 PM", "930".
 */
export function toHHMM(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim().toLowerCase().replace(/\s+/g, "");
  // "930" / "1730": the last two digits are the minutes.
  const run = /^(\d{1,2})(\d{2})(am|pm|a|p)?$/.exec(s);
  const m = run ?? /^(\d{1,2})(?:[:.h](\d{1,2}))?(am|pm|a|p)?$/.exec(s);
  if (!m) return "";
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3];
  if (ap?.startsWith("p") && h < 12) h += 12;
  if (ap?.startsWith("a") && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * A time written after `start` on the same work day: "5:20" after "09:00" is
 * 17:20. Only a morning-looking time that falls before the start moves.
 */
export function laterThan(start: string, t: string): string {
  if (!start || !t || t > start) return t;
  const h = Number(t.slice(0, 2));
  return h < 12 ? `${String(h + 12).padStart(2, "0")}${t.slice(2)}` : t;
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const d = new Date(`${v.trim()}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v.trim() ? null : v.trim();
}

function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The model's reply as a scanned sheet, or null when it is not one. */
export function parseSignInModelOutput(raw: string): ScannedSheet | null {
  const o = firstJsonObject(raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.rows)) return null;
  const rows: ScannedRow[] = [];
  for (const r of o.rows as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const employee = clean(r.employee, 80);
    if (!employee) continue;
    const timeIn = toHHMM(r.time_in);
    const lunchStart = laterThan(timeIn, toHHMM(r.lunch_start));
    const lunchEnd = laterThan(lunchStart || timeIn, toHHMM(r.lunch_end));
    const timeOut = laterThan(lunchEnd || lunchStart || timeIn, toHHMM(r.time_out));
    rows.push({
      employee,
      rateCode: (clean(r.rate_code, 8) ?? "").toUpperCase().replace(/[^A-Z0-9]/g, ""),
      timeIn,
      lunchStart,
      lunchEnd,
      timeOut,
      lodging: r.lodging === true,
      signed: r.signed === true,
    });
    if (rows.length >= SCAN_MAX_ROWS) break;
  }
  return {
    jobName: clean(o.job_name, 120),
    jobLocation: clean(o.job_location, 200),
    date: isoDate(o.date),
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/** A name as a set of lower-case words: "Gutierrez, Rose" and "Rose Gutierrez" match. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/** The person on the crew list this written name is, if any. */
export function matchPerson<P extends { name: string }>(
  written: string,
  people: readonly P[],
): P | null {
  const key = nameKey(written);
  return key ? (people.find((p) => nameKey(p.name) === key) ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* Into the sheet                                                      */
/* ------------------------------------------------------------------ */

/**
 * The checked rows added to the day's sheet. A person already on it (the
 * same name, either way round) gets the paper's values only in boxes that are
 * still empty — what a crew member typed or signed on a phone stands. Anyone
 * else is a new row, linked to their login when the crew list knows them.
 * A rate code the catalogue does not know is left empty for the person to
 * pick rather than saved as a code nobody bills.
 */
export function applyScan(
  sheet: SignInPayload,
  rows: readonly ScannedRow[],
  opts: {
    newId: () => string;
    people: readonly { userId: string | null; name: string }[];
    codes: ReadonlySet<string>;
  },
): { sheet: SignInPayload; added: number; updated: number } {
  const next: SignInRow[] = sheet.rows.map((r) => ({ ...r }));
  let added = 0;
  let updated = 0;
  for (const s of rows) {
    const code = opts.codes.has(s.rateCode) ? s.rateCode : "";
    const lodging = s.lodging ? ("yes" as const) : ("" as const);
    const existing = next.find((r) => r.employee && nameKey(r.employee) === nameKey(s.employee));
    if (existing) {
      const before = JSON.stringify(existing);
      existing.rateCode ||= code;
      existing.timeIn ||= s.timeIn;
      existing.lunchStart ||= s.lunchStart;
      existing.lunchEnd ||= s.lunchEnd;
      existing.timeOut ||= s.timeOut;
      existing.lodging ||= lodging;
      // Signed on the paper: counts as signed unless a phone signature is already there.
      if (s.signed && !existing.signature && !existing.paperSigned) existing.paperSigned = true;
      if (JSON.stringify(existing) !== before) updated++;
      continue;
    }
    const person = matchPerson(s.employee, opts.people);
    next.push({
      id: opts.newId(),
      userId: person?.userId ?? null,
      employee: person?.name ?? s.employee,
      rateCode: code,
      timeIn: s.timeIn,
      lunchStart: s.lunchStart,
      lunchEnd: s.lunchEnd,
      timeOut: s.timeOut,
      lodging,
      signature: null,
      signedAt: null,
      ...(s.signed ? { paperSigned: true } : {}),
    });
    added++;
  }
  return { sheet: { ...sheet, rows: next }, added, updated };
}
