/**
 * Every number in a loss report has to come from the job.
 *
 * The prompt says so, and a prompt is only words to a model. This is the check
 * that runs on what came back: every figure, date and clock time in the draft
 * is looked up in the facts the model was given, and anything that cannot be
 * found is marked in the text — `[[check: 7]]` — so the person approving the
 * draft has to look at it. A draft with a mark left in it cannot be approved
 * (see the report panel); it is never silently "fixed", because a wrong
 * correction is worse than a visible question.
 *
 * Dates and times are matched as dates and times, not as loose digits: "23"
 * in "September 23, 2026" is checked against the dates in the facts, so a
 * plain "a crew of 23" is not waved through just because some date had a 23
 * in it. Identifiers ("GS-26-0523", "DH-12") are accepted when they appear
 * verbatim in the facts.
 *
 * Known limits, stated rather than hidden: the word "one" is not checked (it
 * is used as a pronoun far more than as a count), and a number the facts DO
 * contain can still be attached to the wrong thing. That is what the human
 * review and the figures panel are for.
 *
 * Pure, and safe to import in the browser.
 */

export type FactIndex = {
  numbers: Set<string>;
  /** "2026-09-23" */
  dates: Set<string>;
  /** "9-23" — for a date written without its year. */
  monthDays: Set<string>;
  days: Set<number>;
  years: Set<number>;
  /** Minutes after midnight. A clock with no AM/PM adds both readings. */
  times: Set<number>;
  /** Lower-cased identifiers that mix letters and digits. */
  tokens: Set<string>;
};

export type ProvenanceProblem = {
  /** The text as it stands in the draft. */
  text: string;
  index: number;
  kind: "number" | "date" | "time" | "identifier";
};

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  hundred: 100,
};

const EN_MONTH =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const ES_MONTH =
  "enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre";

type Token =
  | { kind: "date"; start: number; end: number; y: number | null; m: number; d: number }
  | { kind: "year"; start: number; end: number; y: number }
  | { kind: "time"; start: number; end: number; minutes: number[] }
  | { kind: "ordinal"; start: number; end: number; n: number }
  | { kind: "identifier"; start: number; end: number; text: string }
  | { kind: "number"; start: number; end: number; value: string }
  | { kind: "word"; start: number; end: number; value: string };

/** Ordered matchers. Earlier ones claim their span; later ones skip it. */
const MATCHERS: {
  re: RegExp;
  make: (m: RegExpExecArray) => Omit<Token, "start" | "end"> | null;
}[] = [
  {
    // ISO date, optionally with a time. The time of an ISO timestamp is UTC
    // and is never what a report prints, so only the date is kept.
    re: /\b(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
    make: (m) => ({ kind: "date", y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }),
  },
  {
    // September 23, 2026 · Sep 23 · Sept. 23rd, 2026
    re: new RegExp(
      String.raw`\b(${EN_MONTH})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`,
      "gi",
    ),
    make: (m) => ({
      kind: "date",
      m: MONTHS[m[1]!.toLowerCase()]!,
      d: Number(m[2]),
      y: m[3] ? Number(m[3]) : null,
    }),
  },
  {
    // 23 September 2026 · 23rd of September
    re: new RegExp(
      String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${EN_MONTH})\b\.?(?:,?\s+(\d{4})\b)?`,
      "gi",
    ),
    make: (m) => ({
      kind: "date",
      d: Number(m[1]),
      m: MONTHS[m[2]!.toLowerCase()]!,
      y: m[3] ? Number(m[3]) : null,
    }),
  },
  {
    // 23 de septiembre de 2026
    re: new RegExp(
      String.raw`\b(\d{1,2})\s+de\s+(${ES_MONTH})\b(?:\s+(?:de|del)\s+(\d{4})\b)?`,
      "gi",
    ),
    make: (m) => ({
      kind: "date",
      d: Number(m[1]),
      m: MONTHS[m[2]!.toLowerCase()]!,
      y: m[3] ? Number(m[3]) : null,
    }),
  },
  {
    // September 2026
    re: new RegExp(String.raw`\b(?:${EN_MONTH}|${ES_MONTH})\s+(?:de\s+)?(\d{4})\b`, "gi"),
    make: (m) => ({ kind: "year", y: Number(m[1]) }),
  },
  {
    // 9/23/2026 · 09/23/26 · 9/23
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g,
    make: (m) => {
      const mo = Number(m[1]);
      const d = Number(m[2]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
      const y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : null;
      return { kind: "date", m: mo, d, y };
    },
  },
  {
    // 9:50 AM · 4:30pm · 16:30 · 10 a.m.
    // "a.m." keeps its last dot; "AM." leaves the full stop to the sentence.
    re: /\b(\d{1,2})(?::(\d{2}))?\s*(?:([ap])(?:\.\s?m\.|\s?m\b))|\b(\d{1,2}):(\d{2})\b/gi,
    make: (m) => {
      const h = Number(m[1] ?? m[4]);
      const min = Number(m[2] ?? m[5] ?? 0);
      const ap = m[3]?.toLowerCase();
      if (h > 23 || min > 59) return null;
      if (ap) {
        const h24 = (h % 12) + (ap === "p" ? 12 : 0);
        return { kind: "time", minutes: [h24 * 60 + min] };
      }
      const readings = [h * 60 + min];
      if (h < 12) readings.push((h + 12) * 60 + min);
      if (h === 12) readings.push(min);
      return { kind: "time", minutes: readings };
    },
  },
  {
    // 23rd · 1st
    re: /\b(\d{1,2})(?:st|nd|rd|th)\b/gi,
    make: (m) => ({ kind: "ordinal", n: Number(m[1]) }),
  },
  {
    // GS-26-0523 · DH-12 · 4B · KEWR2 — letters and digits in one token
    re: /\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b/g,
    make: (m) => ({ kind: "identifier", text: m[0] }),
  },
  {
    // 1,234.50 · 136 · 6.5 · $2,000
    re: /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g,
    make: (m) => ({ kind: "number", value: canonical(m[0]) }),
  },
  {
    re: new RegExp(String.raw`\b(${Object.keys(NUMBER_WORDS).join("|")})\b`, "gi"),
    make: (m) => ({ kind: "word", value: String(NUMBER_WORDS[m[1]!.toLowerCase()]) }),
  },
];

/** "1,234.50" → "1234.5", "09" → "9". */
export function canonical(raw: string): string {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? String(n) : raw;
}

function tokenize(text: string): Token[] {
  const claimed: [number, number][] = [];
  const free = (s: number, e: number) => claimed.every(([a, b]) => e <= a || s >= b);
  const out: Token[] = [];
  for (const { re, make } of MATCHERS) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!free(start, end)) continue;
      const tok = make(m);
      if (!tok) continue;
      claimed.push([start, end]);
      out.push({ ...tok, start, end } as Token);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function digitGroups(s: string): string[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).map(canonical);
}

function addText(index: FactIndex, text: string) {
  for (const t of tokenize(text)) {
    switch (t.kind) {
      case "date":
        if (t.y != null) {
          index.dates.add(`${t.y}-${t.m}-${t.d}`);
          index.years.add(t.y);
        }
        index.monthDays.add(`${t.m}-${t.d}`);
        index.days.add(t.d);
        break;
      case "year":
        index.years.add(t.y);
        break;
      case "time":
        for (const m of t.minutes) index.times.add(m);
        break;
      case "ordinal":
        index.numbers.add(String(t.n));
        break;
      case "identifier":
        index.tokens.add(t.text.toLowerCase());
        for (const g of digitGroups(t.text)) index.numbers.add(g);
        break;
      case "number":
      case "word":
        index.numbers.add(t.value);
        break;
    }
  }
}

/** Everything the facts let a report say, indexed for lookup. */
export function indexFacts(facts: unknown): FactIndex {
  const index: FactIndex = {
    numbers: new Set(),
    dates: new Set(),
    monthDays: new Set(),
    days: new Set(),
    years: new Set(),
    times: new Set(),
    tokens: new Set(),
  };
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === "number") {
      if (Number.isFinite(v)) index.numbers.add(String(v));
      return;
    }
    if (typeof v === "string") {
      addText(index, v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(facts);
  return index;
}

/** Every figure, date and time in the draft that the facts do not contain. */
export function unsupportedFigures(draft: string, index: FactIndex): ProvenanceProblem[] {
  const out: ProvenanceProblem[] = [];
  const flag = (t: Token, kind: ProvenanceProblem["kind"]) =>
    out.push({ text: draft.slice(t.start, t.end), index: t.start, kind });
  const numberOk = (v: string) => index.numbers.has(v) || index.years.has(Number(v));

  for (const t of tokenize(draft)) {
    // Never re-flag a figure a previous pass already marked.
    if (
      draft
        .slice(Math.max(0, t.start - 9), t.start)
        .toLowerCase()
        .endsWith("[[check: ")
    )
      continue;
    switch (t.kind) {
      case "date": {
        const ok =
          t.y != null
            ? index.dates.has(`${t.y}-${t.m}-${t.d}`)
            : index.monthDays.has(`${t.m}-${t.d}`);
        if (!ok) flag(t, "date");
        break;
      }
      case "year":
        if (!index.years.has(t.y) && !index.numbers.has(String(t.y))) flag(t, "date");
        break;
      case "time":
        if (!t.minutes.some((m) => index.times.has(m))) flag(t, "time");
        break;
      case "ordinal":
        if (!index.days.has(t.n) && !index.numbers.has(String(t.n))) flag(t, "number");
        break;
      case "identifier": {
        if (index.tokens.has(t.text.toLowerCase())) break;
        if (!digitGroups(t.text).every(numberOk)) flag(t, "identifier");
        break;
      }
      case "number":
      case "word":
        if (!numberOk(t.value)) flag(t, "number");
        break;
    }
  }
  return out;
}

export const CHECK_MARK_OPEN = "[[check: ";
export const CHECK_MARK_CLOSE = "]]";

/** Wraps each unsupported figure in a visible mark the reviewer must resolve. */
export function markUnsupported(draft: string, problems: readonly ProvenanceProblem[]): string {
  let out = draft;
  for (const p of [...problems].sort((a, b) => b.index - a.index)) {
    out =
      out.slice(0, p.index) +
      CHECK_MARK_OPEN +
      p.text +
      CHECK_MARK_CLOSE +
      out.slice(p.index + p.text.length);
  }
  return out;
}

/** The figures still marked for checking in a report's text. Empty = clear to approve. */
export function checkMarks(text: string | null | undefined): string[] {
  return [...(text ?? "").matchAll(/\[\[check:\s*([^\]]*)\]\]/gi)].map((m) => m[1]!.trim());
}

/**
 * The one extra instruction a second attempt gets: the exact figures the facts
 * do not support.
 */
export function provenanceInstruction(problems: readonly ProvenanceProblem[]): string {
  if (problems.length === 0) return "";
  const list = [...new Set(problems.map((p) => p.text.trim()))].slice(0, 15);
  return (
    "\n\nYOUR PREVIOUS DRAFT CONTAINED FIGURES THAT ARE NOT IN THE JOB DATA: " +
    list.map((p) => `«${p}»`).join(", ") +
    ". Write the report again from the same JOB DATA. Do not calculate, convert or estimate " +
    "any number; use only the figures, dates and times exactly as the JOB DATA gives them, " +
    "and leave out anything the JOB DATA does not give."
  );
}
