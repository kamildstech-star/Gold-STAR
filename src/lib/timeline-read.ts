/**
 * The timeline read — the part of the suggestion card that actually reads.
 *
 * The Focus list (`account_focus`) counts rows: overdue tasks, cadence due,
 * compliance gaps. Useful, but it tells a rep what they can already see. This
 * module prepares the account's own history for one model pass whose job is
 * the opposite: surface the thing a person would only have caught by reading
 * the whole timeline — a question that was never answered, a commitment that
 * was never kept, a date the client stated that has since gone by.
 *
 * Everything here is pure and runs on both sides:
 *
 *  - `buildTimelineDigest` decides what the model is shown, and just as
 *    importantly what it is not. The entries come from the same
 *    `fetchAccountTimeline` the Timeline card renders, so the model can never
 *    see more than the rep looking at the screen: RLS has already run.
 *  - `timelineFingerprint` / `needsRegeneration` are the cost control. A read
 *    is generated once and reused until the timeline actually moves, so
 *    opening the page a hundred times costs a hundred cached rows and zero
 *    tokens.
 *  - `parseTimelineRead` is the honesty check. An observation is accepted only
 *    if it cites an entry that was in the digest, on that entry's own date,
 *    and quotes text that really appears in it. A fabricated citation is
 *    dropped rather than shown, so a wrong read is visible as a missing
 *    bullet, never as a plausible sentence with no source.
 */
import type { EntryKind, TimelineEntry } from "@/lib/account-timeline";

/** How far back a read looks. Older history is not worth the tokens. */
export const LOOKBACK_DAYS = 365;
/** Hard cap on entries handed to the model, most recent kept. */
export const MAX_DIGEST_ENTRIES = 60;
/** Free text is trimmed to this per entry. */
export const MAX_BODY_CHARS = 400;
/** Below this there is nothing to read, and we say so instead of guessing. */
export const MIN_ENTRIES_FOR_READ = 4;
/** Most observations we will show. Three good ones beat ten padded ones. */
export const MAX_OBSERVATIONS = 3;
/** A read is never regenerated more often than this, even if history moved. */
export const MIN_REGENERATE_INTERVAL_MS = 15 * 60_000;

/**
 * Kinds deliberately withheld from the model.
 *
 *  - `photo`: a grouped upload count with no words in it. Pure token cost.
 *  - `invoice`: the money rule keeps figures off a rep's screen until
 *    commission is issued. The timeline already carries no amounts; excluding
 *    the rows entirely means a read can never drift toward billing talk.
 */
export const EXCLUDED_KINDS: readonly EntryKind[] = ["photo", "invoice"];

export type TimelineDigestRef = {
  /** Stable label the model must copy back, e.g. "E7". */
  ref: string;
  /** The real timeline entry id, used to key dismissals. */
  entryId: string;
  date: string;
  kind: EntryKind;
  /** Everything the model was shown for this entry, for quote checking. */
  text: string;
};

export type TimelineDigest = {
  /** The lines handed to the model, oldest first so it reads forwards. */
  lines: string[];
  refs: TimelineDigestRef[];
  /** Every date present in the digest — the citation allow-list. */
  dates: Set<string>;
  entryCount: number;
  /** High-water mark: the newest entry the digest was built from. */
  latestEntryAt: string | null;
  /** Total entries on the account, including those left out. */
  totalEntries: number;
  fingerprint: string;
};

export type TimelineObservation = {
  /** Content-derived, so dismissing one keeps it dismissed across reads. */
  key: string;
  headline: string;
  detail: string;
  date: string;
  /** Where it came from, in words: "Email", "Note", "Call". */
  sourceLabel: string;
  quote: string | null;
  entryId: string;
};

export type TimelineReadStatus =
  /** A read exists for this state of the timeline. */
  | "ok"
  /** Never generated for this account by this user. */
  | "none"
  /** Too little history to read honestly. */
  | "insufficient"
  /** The model could not be reached, or answered unusably. */
  | "unavailable";

export type CachedReadMark = {
  fingerprint: string;
  latestEntryAt: string | null;
  entryCount: number;
  /** ISO timestamp of when the cached read was produced. */
  generatedAt: string;
};

/* ------------------------------------------------------------ fingerprint */

/**
 * djb2 over the digest source. No crypto import, so this runs identically in
 * the browser, on the server and in a worker.
 */
export function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  let g = 0x811c9dc5;
  for (let i = input.length - 1; i >= 0; i--) {
    g ^= input.charCodeAt(i);
    g = Math.imul(g, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}${(g >>> 0).toString(36)}`;
}

/* ---------------------------------------------------------------- digest */

const KIND_LABEL: Record<EntryKind, string> = {
  note: "Note",
  stage: "Stage change",
  task: "Task",
  email: "Email",
  call: "Call",
  sms: "Text",
  meeting: "Meeting",
  document: "Document",
  gift: "Gift",
  job: "Job",
  photo: "Photos",
  invoice: "Invoice",
};

export function kindLabel(kind: EntryKind): string {
  return KIND_LABEL[kind] ?? "Entry";
}

/**
 * URLs are stripped, not summarised. A recording link or a signed storage URL
 * is credentialed access, and it is no use to a model that cannot open it.
 */
function scrub(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/https?:\/\/\S+/gi, "[link removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_CHARS);
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Choose and format what the model reads.
 *
 * Excluded on purpose, and asserted in the tests: photo and invoice rows,
 * anything flagged private on an email, anything outside the lookback window,
 * every url, every uuid (the model gets a short `E<n>` handle instead, so it
 * cannot echo an internal id into a suggestion), and everything past the
 * newest `MAX_DIGEST_ENTRIES`.
 */
export function buildTimelineDigest(
  entries: TimelineEntry[],
  opts: { now?: Date } = {},
): TimelineDigest {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();

  const eligible = entries
    .filter((e) => !EXCLUDED_KINDS.includes(e.kind))
    .filter((e) => !e.email?.isPrivate)
    .filter((e) => typeof e.at === "string" && e.at >= cutoff)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, MAX_DIGEST_ENTRIES)
    // Read forwards: a commitment made before a deadline that passed only
    // makes sense in order.
    .reverse();

  const refs: TimelineDigestRef[] = [];
  const lines: string[] = [];
  const dates = new Set<string>();

  eligible.forEach((e, i) => {
    const ref = `E${i + 1}`;
    const date = dayOf(e.at);
    const parts = [
      scrub(e.title),
      scrub(e.subtitle),
      e.email
        ? `from ${scrub(e.email.from) || "unknown"} to ${e.email.to.map(scrub).join(", ") || "unknown"}`
        : "",
      e.call?.outcome ? `outcome ${scrub(e.call.outcome)}` : "",
      e.call?.direction ? `${e.call.direction}` : "",
      e.done ? "completed" : "",
      e.overdue ? "past its due date" : "",
      scrub(e.body ?? e.email?.preview),
      ...(e.childNotes ?? []).map((n) => scrub(n.body)),
      e.source ? `via ${scrub(e.source)}` : "",
    ].filter((p) => p.length > 0);

    const text = parts.join(" · ");
    refs.push({ ref, entryId: e.id, date, kind: e.kind, text });
    lines.push(`${ref} | ${date} | ${kindLabel(e.kind)} | ${text}`);
    dates.add(date);
  });

  const latestEntryAt = eligible.length ? eligible[eligible.length - 1]!.at : null;

  return {
    lines,
    refs,
    dates,
    entryCount: eligible.length,
    latestEntryAt,
    totalEntries: entries.length,
    fingerprint: hashString(`${eligible.length}|${latestEntryAt ?? ""}|${lines.join("\n")}`),
  };
}

/* ----------------------------------------------------------- invalidation */

/**
 * The cost control, in one predicate.
 *
 * A cached read is reused unless the timeline it was computed from has changed
 * — and even then not more often than `MIN_REGENERATE_INTERVAL_MS`. Mark's
 * point stands: a stale-but-cheap read beats a fresh expensive one, and a page
 * view must never buy a model call on its own.
 */
export function needsRegeneration(
  cached: CachedReadMark | null,
  current: { fingerprint: string },
  opts: { now?: Date; minIntervalMs?: number } = {},
): boolean {
  if (!cached) return true;
  // The timeline has not moved: nothing a model could say has changed.
  if (cached.fingerprint === current.fingerprint) return false;
  const now = (opts.now ?? new Date()).getTime();
  const age = now - new Date(cached.generatedAt).getTime();
  const min = opts.minIntervalMs ?? MIN_REGENERATE_INTERVAL_MS;
  // History moved, but not long enough ago to be worth another call.
  if (Number.isFinite(age) && age >= 0 && age < min) return false;
  return true;
}

/** True when the cached read predates the current history. */
export function isStale(cached: CachedReadMark | null, current: { fingerprint: string }): boolean {
  return Boolean(cached) && cached!.fingerprint !== current.fingerprint;
}

/* ---------------------------------------------------------------- parsing */

/** Lower-case, punctuation-flattened, for quote and dedupe comparisons. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”]/g, (c) => (c === "‘" || c === "’" ? "'" : '"'))
    .replace(/[^a-z0-9'"\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content-derived dismissal key: rewording a headline does not resurrect it. */
export function observationKey(entryId: string, headline: string): string {
  const stem = normalize(headline).split(" ").slice(0, 8).join(" ");
  return `timeline_read:${hashString(`${entryId}|${stem}`)}`;
}

export type ParsedRead = {
  items: TimelineObservation[];
  /** Why anything was thrown away — surfaced in the audit row, not the UI. */
  rejected: Array<{ reason: string; headline: string; date: string | null }>;
  /** The model said outright there was nothing worth reporting. */
  insufficient: boolean;
};

type RawObservation = {
  headline?: unknown;
  detail?: unknown;
  entry_ref?: unknown;
  date?: unknown;
  quote?: unknown;
};

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Accept an observation only if it can be traced back to the digest.
 *
 * Four gates, in order of how badly a failure would mislead a rep:
 *  1. the cited date must be a date that appeared in the input;
 *  2. the cited entry handle must be one we issued, and carry that same date;
 *  3. a quote, if given, must actually appear in that entry's text;
 *  4. no two observations may cite the same entry with the same point.
 *
 * Anything failing is dropped, never repaired. The rep sees one fewer bullet.
 */
export function parseTimelineRead(
  raw: unknown,
  digest: Pick<TimelineDigest, "refs" | "dates">,
  opts: { dismissedKeys?: Set<string>; max?: number } = {},
): ParsedRead {
  const rejected: ParsedRead["rejected"] = [];
  const items: TimelineObservation[] = [];
  const dismissed = opts.dismissedKeys ?? new Set<string>();
  const max = opts.max ?? MAX_OBSERVATIONS;

  const root = (raw ?? {}) as { observations?: unknown; insufficient?: unknown };
  const list = Array.isArray(root.observations) ? root.observations : [];
  const byRef = new Map(digest.refs.map((r) => [r.ref, r]));
  const seen = new Set<string>();

  for (const entry of list as RawObservation[]) {
    if (items.length >= max) break;
    const headline = str(entry?.headline);
    const detail = str(entry?.detail);
    const date = str(entry?.date);
    const ref = str(entry?.entry_ref);
    const quote = str(entry?.quote) || null;

    if (!headline) {
      rejected.push({ reason: "empty headline", headline, date: date || null });
      continue;
    }
    // (1) The stated date must exist in what we sent. This is the check that
    // catches an invented meeting on a date nothing happened.
    if (!date || !digest.dates.has(date)) {
      rejected.push({
        reason: "cited a date not present in the timeline",
        headline,
        date: date || null,
      });
      continue;
    }
    // (2) The handle must be one of ours, and must agree with the date.
    const source = byRef.get(ref);
    if (!source) {
      rejected.push({ reason: "cited an entry that was not supplied", headline, date });
      continue;
    }
    if (source.date !== date) {
      rejected.push({ reason: "date does not match the cited entry", headline, date });
      continue;
    }
    // (3) A quote has to be real text from that entry.
    if (quote && !normalize(source.text).includes(normalize(quote))) {
      rejected.push({ reason: "quote is not in the cited entry", headline, date });
      continue;
    }

    const key = observationKey(source.entryId, headline);
    if (dismissed.has(key)) {
      rejected.push({ reason: "dismissed by this user", headline, date });
      continue;
    }
    // (4) One point per entry.
    const dedupe = `${source.entryId}|${normalize(headline).split(" ").slice(0, 8).join(" ")}`;
    if (seen.has(dedupe)) {
      rejected.push({ reason: "duplicate of an earlier observation", headline, date });
      continue;
    }
    seen.add(dedupe);

    items.push({
      key,
      headline,
      detail,
      date,
      sourceLabel: kindLabel(source.kind),
      quote,
      entryId: source.entryId,
    });
  }

  return { items, rejected, insufficient: root.insufficient === true };
}

/* ----------------------------------------------------------------- prompt */

export const TIMELINE_READ_SYSTEM = [
  "You read one account's CRM timeline for a property-restoration salesperson and report what a person would only have noticed by reading all of it.",
  "",
  "WHAT TO LOOK FOR — in rough order of value:",
  "- A question or request the client made that was never answered.",
  "- A commitment someone made on our side that was not kept.",
  "- A date or timeline the client stated that has since passed.",
  "- A pattern in how they engage: which channel or number they actually respond on, which they never do.",
  "- A person who appears once and never again, or a new name that has quietly taken over the conversation.",
  "- A change in tone, or a subject that stopped being mentioned.",
  "",
  "WHAT NOT TO REPORT:",
  "- Counts and clocks. How many tasks are overdue, how many days since contact, whether compliance is missing — all of that is computed separately and shown next to you. Repeating it is worse than saying nothing.",
  "- Generic sales advice. 'Follow up soon' is not an observation.",
  "- Anything you cannot point at a specific line of the timeline for.",
  "",
  "HARD RULES:",
  `- Return at most ${MAX_OBSERVATIONS} observations. Returning none is a correct answer and is expected on a quiet account.`,
  "- Never state a fact that is not in the supplied timeline. No inference about people, companies, contracts or events that do not appear there.",
  "- Every observation MUST cite one timeline line: copy its handle into entry_ref verbatim (e.g. \"E7\"), copy that same line's date into date verbatim (YYYY-MM-DD), and copy a short fragment of that line's own words into quote. If the line has no words of its own, set quote to null.",
  "- An observation whose citation does not match the supplied timeline is discarded before the rep sees it, so guessing a date gains you nothing.",
  "- Do not mention dollar amounts, margins, labor rates or anything financial.",
  "- Do not write a message, email or text for the client. You are briefing the rep only.",
  "",
  "Return ONLY a JSON object:",
  '{"observations":[{"headline":"short, specific, under 90 characters","detail":"one or two sentences on why it matters and what to do, under 240 characters","entry_ref":"E7","date":"YYYY-MM-DD","quote":"verbatim fragment or null"}],"insufficient":false}',
  'Set "insufficient" to true only if the timeline is too thin to say anything grounded.',
].join("\n");

/**
 * The user half of the prompt. Kept separate from the network call so a test
 * can assert exactly what goes in — and what stays out.
 */
export function buildTimelineReadPrompt(
  digest: TimelineDigest,
  opts: {
    accountName: string;
    now?: Date;
    /** Headlines this rep already dismissed; the model is told not to repeat them. */
    dismissedHeadlines?: string[];
  },
): string {
  const now = opts.now ?? new Date();
  const dismissed = (opts.dismissedHeadlines ?? []).filter((h) => h.trim().length > 0);
  return [
    `Today is ${now.toISOString().slice(0, 10)}.`,
    `Account: ${opts.accountName}`,
    `Timeline lines supplied: ${digest.entryCount} (of ${digest.totalEntries} entries on the record).`,
    "",
    "TIMELINE (oldest first) — format: handle | date | type | what happened",
    ...digest.lines,
    ...(dismissed.length
      ? [
          "",
          "ALREADY DISMISSED BY THIS REP — do not raise these again, in any wording:",
          ...dismissed.map((h) => `- ${h}`),
        ]
      : []),
  ].join("\n");
}
