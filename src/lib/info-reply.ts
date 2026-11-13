/**
 * Reading a customer's emailed answer to a request for information.
 *
 * Mark, 13 Oct: "when you send an email for info, it needs to have a pop up or
 * a bubble or something that shows that info that should be inputted into the
 * correct fields in the job not as a task".
 *
 * The office sends a "Request for information" template from the job (the
 * template's `intake_form` flag mints an `intake_requests` row with the
 * recipient's address). The customer often just hits Reply and types the
 * answers instead of opening the secure link. This module is the pure half of
 * turning that reply into PROPOSED values for the job's real fields:
 *
 *   - `pickInfoRequest` decides whether an inbound email is a reply to one of
 *     our info requests (same subject thread, or it names the job number);
 *   - `replyLines` turns the email into the lines the CUSTOMER wrote — our own
 *     wording, quoted back underneath, is dropped line for line;
 *   - `extractReplyFields` maps "Label: value" answers onto job columns, the
 *     job's contact phone/email and the office's intake questions, coercing
 *     each value (dates, yes/no, phone numbers) or dropping it.
 *
 * Nothing here writes. The result lands as a pending `intake_submissions` row
 * that a person reviews field by field on the job (intake-submissions-review).
 * No server or browser imports, so the server ingest and the tests share it.
 */

/* ------------------------------------------------------------------ */
/* Targets: what an answer can be written into                         */
/* ------------------------------------------------------------------ */

export type ReplyValueKind =
  "text" | "date" | "time" | "bool" | "phone" | "email" | "money" | "choice";

export type ReplyTarget = {
  /**
   * Where the value is stored in `intake_submissions`:
   *   - `field`: `fields[<id>]` — a job column, or customer_phone/customer_email;
   *   - `answer`: `answers[<questionId>]` — an intake question.
   */
  store: "field" | "answer";
  /** Job column / field name, or the question id. */
  id: string;
  label: string;
  /** Normalised label spellings that point at this target. */
  synonyms: string[];
  kind: ReplyValueKind;
  choices?: string[];
};

type JobTargetSeed = { id: string; label: string; kind: ReplyValueKind; synonyms: string[] };

/**
 * Job fields a customer can plausibly answer by email. Column names are the
 * job's own (src/lib/job-fields.ts), so Apply writes through the same path as
 * the job's Edit all forms. customer_phone / customer_email are the two keys
 * the intake form already uses; they become a phone/email on the job's Phones &
 * emails list.
 */
const JOB_TARGET_SEEDS: JobTargetSeed[] = [
  {
    id: "customer_name",
    label: "Insured name",
    kind: "text",
    synonyms: [
      "insured name",
      "insured",
      "customer name",
      "name",
      "full name",
      "homeowner",
      "homeowner name",
      "owner name",
      "policyholder",
      "policy holder",
      "policyholder name",
    ],
  },
  {
    id: "loss_date",
    label: "Date of loss",
    kind: "date",
    synonyms: [
      "date of loss",
      "loss date",
      "dol",
      "date of the loss",
      "date loss occurred",
      "date it happened",
      "when did the loss happen",
      "when did the loss occur",
      "when did it happen",
      "when did this happen",
      "when did the damage happen",
      "when did the damage occur",
    ],
  },
  {
    id: "insurance_carrier",
    label: "Insurance carrier",
    kind: "text",
    synonyms: [
      "insurance carrier",
      "carrier",
      "insurance company",
      "insurance",
      "insurer",
      "insurance co",
      "carrier name",
    ],
  },
  {
    id: "policy_number",
    label: "Policy #",
    kind: "text",
    synonyms: ["policy number", "policy", "policy num", "insurance policy number"],
  },
  {
    id: "claim_number",
    label: "Claim #",
    kind: "text",
    synonyms: ["claim number", "claim", "claim num", "insurance claim number"],
  },
  { id: "deductible", label: "Deductible", kind: "money", synonyms: ["deductible"] },
  {
    id: "adjuster_name",
    label: "Carrier adjuster",
    kind: "text",
    synonyms: [
      "adjuster",
      "adjuster name",
      "carrier adjuster",
      "insurance adjuster",
      "adjusters name",
    ],
  },
  {
    id: "adjuster_email",
    label: "Carrier adjuster email",
    kind: "email",
    synonyms: ["adjuster email", "adjusters email", "adjuster email address"],
  },
  {
    id: "adjuster_phone",
    label: "Carrier adjuster phone",
    kind: "phone",
    synonyms: ["adjuster phone", "adjuster number", "adjuster phone number", "adjusters phone"],
  },
  {
    id: "public_adjuster_name",
    label: "Public adjuster",
    kind: "text",
    synonyms: ["public adjuster", "public adjuster name", "pa"],
  },
  {
    id: "insurance_agent_name",
    label: "Insurance agent",
    kind: "text",
    synonyms: ["insurance agent", "agent", "agent name"],
  },
  {
    id: "insurance_agent_phone",
    label: "Agent phone",
    kind: "phone",
    synonyms: ["agent phone", "agent number", "agent phone number"],
  },
  {
    id: "insurance_agent_email",
    label: "Agent email",
    kind: "email",
    synonyms: ["agent email", "agent email address"],
  },
  {
    id: "address_line2",
    label: "Unit / floor",
    kind: "text",
    synonyms: ["unit", "unit number", "apt", "apartment", "apartment number", "suite", "floor"],
  },
  {
    id: "initial_loss_description",
    label: "Initial loss description",
    kind: "text",
    synonyms: [
      "what happened",
      "description of loss",
      "loss description",
      "cause of loss",
      "cause of the loss",
      "description",
    ],
  },
  {
    id: "customer_phone",
    label: "Phone",
    kind: "phone",
    synonyms: [
      "phone",
      "phone number",
      "cell",
      "cell phone",
      "cell number",
      "mobile",
      "mobile number",
      "best number",
      "best phone",
      "best phone number",
      "contact number",
      "contact phone",
      "telephone",
      "callback number",
      "number to reach you",
      "best number to reach you",
    ],
  },
  {
    id: "customer_email",
    label: "Email",
    kind: "email",
    synonyms: ["email", "email address", "best email", "contact email"],
  },
];

export const JOB_REPLY_TARGETS: ReplyTarget[] = JOB_TARGET_SEEDS.map((s) => ({
  store: "field",
  id: s.id,
  label: s.label,
  kind: s.kind,
  synonyms: [...new Set(s.synonyms.map(normalizeLabel))],
}));

/** Keys on `intake_submissions.fields` that are contact methods, not job columns. */
export const CONTACT_FIELD_KIND: Record<string, "phone" | "email"> = {
  customer_phone: "phone",
  customer_email: "email",
};

export type ReplyQuestion = {
  id: string;
  prompt: string;
  answer_type: string;
  choices?: string[] | null;
};

const QUESTION_KIND: Record<string, ReplyValueKind | undefined> = {
  text: "text",
  long_text: "text",
  yes_no: "bool",
  date: "date",
  choice: "choice",
};

/** "Is the power on?" -> "power on" — the way people write it back. */
function questionCore(prompt: string): string {
  return normalizeLabel(prompt).replace(
    /^(?:(?:is|are|was|were|has|have|had|did|do|does|will|can)\s+)?(?:(?:the|there|a|an|you|your|it)\s+)?/,
    "",
  );
}

/** The office's own questionnaire (Admin › Intake questions) as targets. */
export function questionTargets(questions: ReplyQuestion[]): ReplyTarget[] {
  const out: ReplyTarget[] = [];
  for (const q of questions) {
    const kind = QUESTION_KIND[q.answer_type];
    if (!kind) continue; // reported_source writes to the job, not an answer
    const full = normalizeLabel(q.prompt);
    const core = questionCore(q.prompt);
    out.push({
      store: "answer",
      id: q.id,
      label: q.prompt.trim(),
      kind,
      choices: kind === "choice" ? (q.choices ?? []).filter(Boolean) : undefined,
      synonyms: [...new Set([full, core].filter((s) => s.length >= 2))],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Text handling                                                       */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Server-side HTML -> text. Good enough for mail bodies; no DOM needed. */
export function mailHtmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (ENTITIES[lower] != null) return ENTITIES[lower]!;
      if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#")) return String.fromCodePoint(Number(lower.slice(1)));
      return m;
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ");
}

/** Where the customer's own words stop and the quoted thread begins. */
const QUOTE_START = [
  /^on .{3,200} wrote:?$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^_{5,}$/,
  /^from:\s.+/i,
  /^sent from my /i,
];

/** The new part of a reply — what shows as the "source email" snippet. */
export function stripQuotedReply(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (QUOTE_START.some((re) => re.test(line))) break;
    if (line.startsWith(">")) continue;
    out.push(raw.trimEnd());
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const HEADER_LINE = /^(from|sent|to|cc|subject|date):\s/i;
const lineSig = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The lines of a reply worth reading for answers. Customers answer inline as
 * often as on top, so the quoted thread is kept — but every line that appears
 * verbatim in the email WE sent is dropped, as are the quoted headers. An
 * inline answer changes its line ("Date of loss: 10/3"), so it survives.
 */
export function replyLines(replyText: string, sentText: string | null): string[] {
  const ours = new Set(
    (sentText ?? "")
      .split("\n")
      .map(lineSig)
      .filter((s) => s.length > 0),
  );
  const out: string[] = [];
  for (const raw of replyText.split("\n")) {
    const line = raw.replace(/^[\s>]+/, "").trim();
    if (!line) continue;
    if (HEADER_LINE.test(line)) continue;
    if (ours.has(lineSig(line))) continue;
    out.push(line);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/** Lowercase, "#"/"no." spelled as "number", punctuation gone, filler words off. */
export function normalizeLabel(label: string): string {
  let s = label
    .toLowerCase()
    .replace(/e-mail/g, "email")
    .replace(/#/g, " number ")
    .replace(/\bno\.(?=\s|$)/g, " number ")
    .replace(/\bnum\b/g, " number ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(?:\d+|[a-z])\s+(?=\S)/, (m) => (/^\d/.test(m) ? "" : m));
  s = s.replace(
    /^(?:please (?:provide|confirm|send)\s+)?(?:what is|whats|what s)?\s*(?:your|the|my|our)?\s*/,
    "",
  );
  return s.replace(/\bnumber number\b/g, "number").trim();
}

/** Best target for a written label, or null. Exact spellings beat partial ones. */
export function matchTarget(
  label: string,
  targets: ReplyTarget[],
  { exactOnly = false }: { exactOnly?: boolean } = {},
): ReplyTarget | null {
  const norm = normalizeLabel(label);
  if (!norm || norm.length > 80) return null;
  let best: { t: ReplyTarget; score: number } | null = null;
  for (const t of targets) {
    for (const syn of t.synonyms) {
      let score = 0;
      if (norm === syn) score = 3;
      else if (!exactOnly && syn.length >= 5) {
        const padded = ` ${norm} `;
        if (padded.includes(` ${syn} `)) score = 2 + syn.length / 100;
      }
      if (score > (best?.score ?? 0)) best = { t, score };
    }
  }
  return best?.t ?? null;
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * A date as written in an email -> `yyyy-mm-dd`. US order (the company is in
 * New Jersey). With no year, the year of `reference` — or the one before when
 * that would put the date in the future, since a loss has already happened.
 */
export function coerceReplyDate(value: string, reference: Date): string | null {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  const refY = reference.getUTCFullYear();
  const finish = (y: number | null, m: number, d: number): string | null => {
    let year = y ?? refY;
    if (y != null && y < 100) year = 2000 + y;
    if (!validDate(year, m, d)) return null;
    if (y == null) {
      const candidate = Date.UTC(year, m - 1, d);
      if (candidate > reference.getTime() + 86_400_000) year -= 1;
      if (!validDate(year, m, d)) return null;
    }
    return `${year}-${pad(m)}-${pad(d)}`;
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(v);
  if (m) return finish(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?\b/.exec(v);
  if (m) return finish(m[3] ? Number(m[3]) : null, Number(m[1]), Number(m[2]));
  m = /^(?:[a-z]+,?\s+)?([a-z]{3,9})\.?\s+(\d{1,2}),?(?:\s+(\d{4}))?\b/.exec(v);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.slice(0, 3));
    if (mi >= 0) return finish(m[3] ? Number(m[3]) : null, mi + 1, Number(m[2]));
  }
  m = /^(\d{1,2})\s+([a-z]{3,9})\.?,?(?:\s+(\d{4}))?\b/.exec(v);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3));
    if (mi >= 0) return finish(m[3] ? Number(m[3]) : null, mi + 1, Number(m[1]));
  }
  return null;
}

const YES = new Set(["yes", "y", "yeah", "yep", "yup", "correct", "true", "on", "affirmative"]);
const NO = new Set(["no", "n", "nope", "false", "off", "not", "negative", "none"]);

export function coerceReplyBool(value: string): boolean | null {
  const first = value
    .trim()
    .toLowerCase()
    .split(/[^a-z]+/)
    .find(Boolean);
  if (!first) return null;
  if (YES.has(first)) return true;
  if (NO.has(first)) return false;
  return null;
}

/** US numbers only, printed the way the office types them: (732) 555-0142. */
export function coerceReplyPhone(value: string): string | null {
  const m =
    /(\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?:\s*(?:x|ext\.?)\s*(\d{1,6}))?/i.exec(
      value,
    );
  if (!m) return null;
  const base = `(${m[2]}) ${m[3]}-${m[4]}`;
  return m[5] ? `${base} x${m[5]}` : base;
}

export function coerceReplyEmail(value: string): string | null {
  const m = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(value);
  return m ? m[0].toLowerCase() : null;
}

function coerceChoice(value: string, choices: string[]): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  const exact = choices.find((c) => c.trim().toLowerCase() === v);
  if (exact) return exact;
  const within = choices
    .filter((c) => c.trim().length >= 3 && v.includes(c.trim().toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  if (within) return within;
  const starts = choices.find((c) => v.length >= 3 && c.trim().toLowerCase().startsWith(v));
  return starts ?? null;
}

const UNKNOWN = /^(?:n\/?a|unknown|not sure|dont know|don't know|idk|tbd|\?+|-+)$/i;

export type ReplyAnswer = { text?: string | null; bool?: boolean | null; date?: string | null };

/** One written value, coerced for its target — or null when it does not read as one. */
export function coerceReplyValue(
  target: ReplyTarget,
  raw: string,
  reference: Date,
): { field?: string; answer?: ReplyAnswer } | null {
  const value = raw.trim().replace(/[.;,]+$/, "");
  if (!value || UNKNOWN.test(value) || value.length > 500) return null;
  const wrap = (field: string | null, answer: ReplyAnswer | null) => {
    if (target.store === "answer") return answer ? { answer } : null;
    return field != null ? { field } : null;
  };
  switch (target.kind) {
    case "date": {
      const d = coerceReplyDate(value, reference);
      return d ? wrap(d, { date: d }) : null;
    }
    case "bool": {
      const b = coerceReplyBool(value);
      return b == null ? null : wrap(b ? "true" : "false", { bool: b });
    }
    case "phone": {
      const p = coerceReplyPhone(value);
      return p ? wrap(p, { text: p }) : null;
    }
    case "email": {
      const e = coerceReplyEmail(value);
      return e ? wrap(e, { text: e }) : null;
    }
    case "money": {
      const n = Number(value.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) && n >= 0 ? wrap(String(n), { text: String(n) }) : null;
    }
    case "time": {
      const t = /^(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(value);
      if (!t) return null;
      let h = Number(t[1]);
      if (t[3]?.toLowerCase() === "pm" && h < 12) h += 12;
      if (t[3]?.toLowerCase() === "am" && h === 12) h = 0;
      if (h > 23 || Number(t[2]) > 59) return null;
      const out = `${pad(h)}:${t[2]}`;
      return wrap(out, { text: out });
    }
    case "choice": {
      const c = coerceChoice(value, target.choices ?? []);
      return c ? wrap(c, { text: c }) : null;
    }
    default:
      return wrap(value, { text: value });
  }
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

export type ReplyExtraction = {
  fields: Record<string, string>;
  answers: Record<string, ReplyAnswer>;
};

export const extractionCount = (x: ReplyExtraction) =>
  Object.keys(x.fields).length + Object.keys(x.answers).length;

/** "1. Date of loss: 10/3", "Power on? Yes", "Claim # - 123", "Unit = 2B". */
const LABELLED =
  /^(?:[-*•]\s*|\(?\d{1,2}[.)]\s*|[a-z][.)]\s+)?(.{1,80}?)\s*(?:[:=]|\?|\s[-–—]\s)\s*(.+)$/i;
/** "My policy number is ABC123" — accepted only for an exact label. */
const SENTENCE = /^(.{2,60}?)\s+(?:is|was|are|were)\s+(.+)$/i;
/** A question or label alone on its line; the answer is the next line. */
const LABEL_ONLY = /^(?:[-*•]\s*|\(?\d{1,2}[.)]\s*)?(.{2,80}?)\s*[:?]$/;

/**
 * Map the customer's lines onto targets. First answer per target wins (the
 * top of a reply is the newest thing they wrote). A value that does not read
 * as its kind — "Date of loss: last week" — is dropped rather than guessed.
 */
export function extractReplyFields(
  lines: string[],
  targets: ReplyTarget[],
  reference: Date,
): ReplyExtraction {
  const out: ReplyExtraction = { fields: {}, answers: {} };
  const take = (target: ReplyTarget, raw: string): boolean => {
    const bucket = target.store === "answer" ? out.answers : out.fields;
    if (target.id in bucket) return false;
    const v = coerceReplyValue(target, raw, reference);
    if (!v) return false;
    if (target.store === "answer" && v.answer) out.answers[target.id] = v.answer;
    if (target.store === "field" && v.field != null) out.fields[target.id] = v.field;
    return true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const only = LABEL_ONLY.exec(line);
    if (only) {
      const t = matchTarget(only[1]!, targets);
      const next = lines[i + 1];
      if (t && next && !LABEL_ONLY.test(next) && take(t, next)) {
        i += 1;
        continue;
      }
    }
    const labelled = LABELLED.exec(line);
    if (labelled) {
      const t = matchTarget(labelled[1]!, targets);
      if (t && take(t, labelled[2]!)) continue;
    }
    const sentence = SENTENCE.exec(line.replace(/[.!]+$/, ""));
    if (sentence) {
      const t = matchTarget(sentence[1]!, targets, { exactOnly: true });
      if (t) take(t, sentence[2]!);
    }
  }
  return out;
}

/** The model's raw values ({id: "as written"}) through the same coercion. */
export function coerceModelValues(
  values: unknown,
  targets: ReplyTarget[],
  reference: Date,
): ReplyExtraction {
  const out: ReplyExtraction = { fields: {}, answers: {} };
  if (!values || typeof values !== "object" || Array.isArray(values)) return out;
  for (const [id, raw] of Object.entries(values as Record<string, unknown>)) {
    if (typeof raw !== "string" && typeof raw !== "boolean" && typeof raw !== "number") continue;
    const target = targets.find((t) => modelId(t) === id);
    if (!target) continue;
    const text = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw);
    const v = coerceReplyValue(target, text, reference);
    if (!v) continue;
    if (target.store === "answer" && v.answer) out.answers[target.id] = v.answer;
    if (target.store === "field" && v.field != null) out.fields[target.id] = v.field;
  }
  return out;
}

/** How a target is named to the model: questions are prefixed so ids never collide. */
export const modelId = (t: ReplyTarget) => (t.store === "answer" ? `q:${t.id}` : t.id);

/* ------------------------------------------------------------------ */
/* Which request is this a reply to?                                   */
/* ------------------------------------------------------------------ */

/** "RE: FW: Request for information — 12 Main St" -> "request for information 12 main st". */
export function normalizeSubject(subject: string | null | undefined): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^\s*(?:re|fw|fwd|aw|sv|wg)\s*(?:\[\d+\])?\s*:\s*/i, "");
    if (next === s) break;
    s = next;
  }
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export type InfoRequestCandidate = {
  requestId: string;
  jobId: string;
  jobNumber: string | null;
  createdAt: string;
  /** Subjects of the emails that carried this request. */
  sentSubjects: string[];
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The info request an inbound email answers, or null. The caller has already
 * limited candidates to requests sent to this sender. A reply in the same
 * subject thread wins; failing that, an email that names the job number. The
 * newest matching request is taken.
 */
export function pickInfoRequest(
  reply: { subject: string | null | undefined; text: string },
  candidates: InfoRequestCandidate[],
  /** false: the subject thread only (the cheap first pass, before the body is read). */
  { byJobNumber = true }: { byJobNumber?: boolean } = {},
): InfoRequestCandidate | null {
  const newest = [...candidates].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const subject = normalizeSubject(reply.subject);
  if (subject) {
    const bySubject = newest.find((c) =>
      c.sentSubjects.some((s) => {
        const sent = normalizeSubject(s);
        return sent.length > 0 && sent === subject;
      }),
    );
    if (bySubject) return bySubject;
  }
  if (!byJobNumber) return null;
  const haystack = `${reply.subject ?? ""}\n${reply.text}`;
  return (
    newest.find((c) => {
      const n = (c.jobNumber ?? "").trim();
      if (n.length < 3) return false;
      return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(n)}([^A-Za-z0-9]|$)`, "i").test(haystack);
    }) ?? null
  );
}
