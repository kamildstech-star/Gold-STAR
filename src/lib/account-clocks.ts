/**
 * Account types decide whether the follow-up clocks run — the one definition.
 *
 * Mark, 10 Sep 2026, verbatim:
 *
 *   "Account types. The type decides whether the follow-up clock runs at all.
 *    Management companies, brokers, TPAs, and commercial property owners all
 *    get both clocks and can go Critical.
 *    Homeowners get neither clock. They are a one time job. There is no future
 *    sale to protect, so there is nothing to follow up on. A homeowner can
 *    never go Critical. Their record links to whichever broker sent them, and
 *    the job shows on both timelines, but the broker is the one whose clock is
 *    ticking.
 *    House accounts belong to the company rather than a rep."
 *
 * "Both clocks" are the two timers this codebase already runs on an account:
 *
 *   relationship clock  src/lib/client-health.ts — days since a touchpoint
 *                       that counts toward cadence. This is the one that ends
 *                       in Critical (Ghosted on the Farming board).
 *   follow-up clock     src/lib/pipeline-rules.ts — the outreach standard and
 *                       the ghost timer that moves a silent prospect to
 *                       Ghosted, and the compliance chasing hung off it.
 *
 * SAFETY RULE, and the reason this module exists at all: a homeowner shown as
 * Critical is a false alarm, and a rep who drives out to save a relationship
 * that was one wet basement in 2024 has lost the morning. Nothing computed
 * from metrics may put a homeowner in a band above Healthy.
 *
 * WHY THE RULE KEYS OFF `accounts.account_type`, NOT THE ONBOARDING LABELS
 * -----------------------------------------------------------------------
 * Mark's own sentence is "the TYPE decides". The six onboarding categories
 * (src/lib/onboarding-questions.ts, made into labels by migration
 * 20260910190000) decide which QUESTIONS a new client is asked; they cannot
 * decide this, because their "Direct Owner" covers both a homeowner and a
 * commercial property owner — precisely the two Mark puts on opposite sides of
 * the rule. So the type is the authority. Labels and `what_they_do` are read
 * only as corroboration for accounts whose type does not decide, and they can
 * only ever turn clocks ON, never off.
 *
 * WHY "Residential" IS NOT "Homeowner"
 * ------------------------------------
 * The live `account_type` list has no homeowner entry; the nearest is
 * `residential`. It is tempting to reuse it and wrong to: every account
 * carrying it today is a business — "Brooklyn Realty 3", "Flatbush Co-op Board
 * Alliance", "Triangle Student Housing". `residential` names the SECTOR the
 * account works in, not an individual with one flooded kitchen. Reusing it
 * would have silently switched the clocks off on thirteen live B2B prospects,
 * which is the same class of mistake in the other direction. `homeowner` is
 * therefore its own type, seeded by migration
 * 20260911090000_homeowner_account_type_house_accounts.sql, and a homeowner is
 * only ever a record somebody deliberately typed as one.
 *
 * The default for every other type — including ones nobody has thought about
 * yet — is that both clocks run, which is exactly today's behaviour. This
 * change can only ever quieten a homeowner; it cannot start a clock that was
 * not already ticking.
 */

/* ----------------------------------------------------------------- types */

/** The type keys that mean "an individual with one loss", in any spelling. */
export const HOMEOWNER_TYPE_KEYS = ["homeowner", "home_owner", "homeowners"] as const;

/**
 * The four Mark named as clocked, spelled the way the managed list and the
 * `account_function` list spell them.
 *
 * Listing them changes no behaviour on its own — the default is already
 * "clocks run". They are here so the rule reads like the sentence it came
 * from, and so a test can assert each of Mark's four by name rather than
 * asserting "not a homeowner" four times.
 */
export const CLOCKED_TYPE_KEYS = [
  // Management companies
  "property_management",
  "management",
  // Brokers
  "insurance_broker",
  "broker",
  // TPAs
  "tpa",
  "tpa_network",
  // Commercial property owners
  "commercial",
  "property_owner",
  "commercial_property_owner",
  "direct_owner",
] as const;

/**
 * The label that says an account belongs to the company rather than a rep.
 * Seeded as an account label by the same migration; the name is the contract,
 * exactly as ONBOARDING_LABEL_TITLE is.
 */
export const HOUSE_ACCOUNT_LABEL = "House Account";

/** Everything the rule needs. Every field optional — callers know different amounts. */
export type AccountClockSubject = {
  /** `accounts.account_type` — the managed option's key, kept in sync by trigger. */
  account_type?: string | null;
  /** `accounts.what_they_do` — `account_function` keys. Corroboration only. */
  what_they_do?: string[] | null;
  /** Account label NAMES, when the caller has them ("House Account", "Management"). */
  labels?: readonly string[] | null;
  /** `accounts.assigned_rep` — null means nobody's book. */
  assigned_rep?: string | null;
};

export type AccountClockVerdict = {
  /** The relationship clock: days since a cadence touch, the Critical one. */
  relationshipClock: boolean;
  /** The follow-up clock: the outreach standard and the ghost timer. */
  followUpClock: boolean;
  /** False for a homeowner, and only for a homeowner. */
  canGoCritical: boolean;
  isHomeowner: boolean;
  /** Company-owned: owner-level relationships, TPA work, an account between reps. */
  isHouseAccount: boolean;
  /** Whose clock it is when one runs. A house account's belongs to the company. */
  clockOwner: "rep" | "company";
  /** One line a rep can read: why this account has, or has not, a clock. */
  reason: string;
};

/* -------------------------------------------------------------- matching */

function norm(v: string | null | undefined): string {
  return (v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function inList(key: string, list: readonly string[]): boolean {
  return key !== "" && list.includes(key);
}

/**
 * A homeowner, and nothing else, switches the clocks off.
 *
 * Only the type is consulted. `what_they_do` is not: it is a free-ish list
 * that the live data already fills with loss types ("water", "mold") rather
 * than functions, so letting it turn a clock off would switch clocks off by
 * accident. A label cannot do it either — see the note at the top about
 * "Direct Owner" covering both sides of the rule.
 */
export function isHomeownerAccount(subject: AccountClockSubject): boolean {
  return inList(norm(subject.account_type), HOMEOWNER_TYPE_KEYS);
}

/**
 * House accounts are declared, never guessed.
 *
 * An account with no rep on it is usually just a record nobody has picked up
 * yet, so inferring "house account" from an empty `assigned_rep` would rename
 * a quarter of the book. Somebody puts the label on.
 */
export function isHouseAccount(subject: AccountClockSubject): boolean {
  const wanted = norm(HOUSE_ACCOUNT_LABEL);
  return (subject.labels ?? []).some((n) => norm(n) === wanted);
}

/** True when the type is one Mark named, or one of those functions is claimed. */
export function isNamedClockedAccount(subject: AccountClockSubject): boolean {
  if (inList(norm(subject.account_type), CLOCKED_TYPE_KEYS)) return true;
  return (subject.what_they_do ?? []).some((fn) => inList(norm(fn), CLOCKED_TYPE_KEYS));
}

/* --------------------------------------------------------------- verdict */

export function accountClocks(subject: AccountClockSubject): AccountClockVerdict {
  const house = isHouseAccount(subject);
  // A house account has no rep by definition; an account nobody has been given
  // is the company's too, which is a statement of fact rather than a rule.
  const clockOwner: "rep" | "company" = house || !subject.assigned_rep ? "company" : "rep";

  if (isHomeownerAccount(subject)) {
    return {
      relationshipClock: false,
      followUpClock: false,
      canGoCritical: false,
      isHomeowner: true,
      isHouseAccount: house,
      clockOwner,
      // Mark's reason, not ours — a rep who sees this needs to know it is
      // deliberate and not a record with missing data.
      reason: "Homeowner — a one-time job, so there is no follow-up clock",
    };
  }

  return {
    relationshipClock: true,
    followUpClock: true,
    canGoCritical: true,
    isHomeowner: false,
    isHouseAccount: house,
    clockOwner,
    reason: house
      ? "House account — both clocks run, and they are the company's, not a rep's"
      : "Both clocks run",
  };
}

/** The short question almost every caller actually asks. */
export function clocksRun(subject: AccountClockSubject | null | undefined): boolean {
  return subject ? accountClocks(subject).relationshipClock : true;
}

/**
 * Why the clocks are off, for a badge or a card, or null when they are on.
 * Null rather than "Both clocks run" so a caller can render nothing at all.
 */
export function clockSuppressionReason(subject: AccountClockSubject): string | null {
  const v = accountClocks(subject);
  return v.relationshipClock ? null : v.reason;
}
