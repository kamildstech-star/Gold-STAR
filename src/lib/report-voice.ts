/**
 * The report must read like a person wrote it, and a person does not quote
 * figures back as records.
 *
 * David, 22 Sep: "I don't want it to phrase and quote — 'the job was recorded
 * 16 hours, 16 total hours'... write it out as a report type of thing and not
 * as quotes."
 *
 * The 18 Sep rewrite banned the nouns that name a source — field forms, time
 * clock, records, logs, systems. It did not ban the VERBS and shapes that
 * quote a figure as an entry in a ledger: "was recorded", "logged", "a total
 * of", "16 total hours", a figure in brackets or quotation marks. And the ban
 * was only ever prompt text; nothing looked at what came back. This module is
 * that look, kept pure so every phrase David objects to is a unit test.
 */

export type VoiceProblem = { phrase: string; rule: string };

const PATTERNS: { rule: string; re: RegExp }[] = [
  {
    rule: "recorded / on record",
    re: /\b(?:recorded|on record|as recorded|per (?:the )?records?)\b/gi,
  },
  { rule: "logged", re: /\blogged\b/gi },
  { rule: "a total of", re: /\ba total of\b/gi },
  { rule: "totaling N", re: /\btotal(?:ing|ling|ed|led)\s+(?:of\s+)?\d/gi },
  { rule: "N total hours", re: /\b\d+(?:\.\d+)?\s+total\s+(?:man[- ])?hours?\b/gi },
  { rule: "hours recorded / logged", re: /\bhours\s+(?:were\s+)?(?:recorded|logged|entered)\b/gi },
  {
    rule: "figure in brackets",
    re: /\(\s*\d+(?:\.\d+)?\s*(?:man[- ])?(?:hours?|days?|units?|machines?)\s*\)/gi,
  },
  { rule: "figure in quotation marks", re: /["“”]\s*\d[^"“”\n]{0,40}["“”]/g },
  {
    rule: "names a source",
    re: /\b(?:according to|the data shows|field forms?|daily forms?|time[- ]clock)\b/gi,
  },
];

/** Every place the text quotes a figure or names where it came from. */
export function voiceProblems(text: string): VoiceProblem[] {
  const out: VoiceProblem[] = [];
  for (const { rule, re } of PATTERNS) {
    for (const m of text.matchAll(re)) out.push({ phrase: m[0], rule });
  }
  return out;
}

/**
 * The one extra instruction a second attempt gets: the exact phrases to lose.
 * Naming them works better than restating the rule, which the first attempt
 * already had.
 */
export function rewriteInstruction(problems: VoiceProblem[]): string {
  const phrases = [...new Set(problems.map((p) => p.phrase.trim()))].slice(0, 12);
  return (
    "\n\nYOUR PREVIOUS DRAFT QUOTED FIGURES OR NAMED A SOURCE. Write the report again from the " +
    "same JOB DATA without any of these phrases: " +
    phrases.map((p) => `«${p}»`).join(", ") +
    ". Put each figure into a plain sentence about the work, once."
  );
}

/**
 * The crew block as the model sees it: one hours figure, not four.
 *
 * On a job worked off daily forms, total, approved and form hours are usually
 * the same number, and handing the model all of them is how "16 hours, 16
 * total hours" gets written — it restates the figure under each name. The
 * stored snapshot (the figures panel) keeps everything; only the prompt is
 * narrowed.
 */
export function crewForModel(crew: Record<string, unknown>): Record<string, unknown> {
  const pick: Record<string, unknown> = { man_hours_on_site: crew["total_hours"] };
  for (const k of [
    "crew_days",
    "days_on_site",
    "distinct_people",
    "named_people",
    "peak_crew",
    "assignments",
  ]) {
    if (k in crew) pick[k] = crew[k];
  }
  if (Array.isArray(crew["by_day"])) {
    pick["by_day"] = (crew["by_day"] as Record<string, unknown>[]).map((d) => {
      const day: Record<string, unknown> = {};
      for (const k of ["date", "work_date", "hours", "crew_size"]) if (k in d) day[k] = d[k];
      return day;
    });
  }
  return pick;
}
