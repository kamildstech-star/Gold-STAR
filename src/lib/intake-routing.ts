/**
 * Which office should take a lead from a general intake link, given only the
 * address the customer typed.
 *
 * An office (public.locations) sits in a state (`region`, e.g. "NJ") and a
 * town (`locality`, e.g. "Lakewood"), and has a map point. When the customer
 * picked their address from the type-ahead, the form carries its point too,
 * and the lead goes to the CLOSEST office — David, 22 Sep: "one link that
 * automatically chooses the office based on the location they're reporting."
 * A hand-typed address has no point (the form throws it away on edit), so it
 * falls back to the text rules: the office in that state, preferring one whose
 * town is named in the address; otherwise the configured fallback office.
 *
 * Pure — no Supabase, no React — so the server function and the tests share
 * exactly one implementation.
 */

/** app_settings.key holding the general-link settings (see intake-general-settings.ts). */
export const INTAKE_GENERAL_SETTINGS_KEY = "intake_general";

export type RoutableLocation = {
  id: string;
  code: string;
  name: string;
  /** State, as stored on locations.region ("NJ"). */
  region: string | null;
  /** Town, as stored on locations.locality ("Lakewood"). */
  locality: string | null;
  /** The office's map point. Absent, or 0/0, means "not placed" and never "closest". */
  lat?: number | null;
  lon?: number | null;
  active?: boolean;
};

/** Where the property is, when the form knows. */
export type RoutingPoint = { lat: number; lon: number };

/**
 * An explicit "this territory belongs to that office" rule, kept on Settings ›
 * Sales › Territory (`intake_office_rules`, 20261006170000).
 *
 * Mark: "add in here a address match for intake, that will set certain states
 * to certain offices that overrides the closest match". Scranton is closer to
 * the Upstate office than to anything in Pennsylvania because there is nothing
 * in Pennsylvania — so distance alone sends every PA lead to NY-Upstate,
 * whoever actually covers PA. A rule says who does.
 *
 * `state` is a two-letter code ("PA"). `zip` is a ZIP prefix of three to five
 * digits ("185" is Scranton's sectional center, "18508" one ZIP).
 */
export type IntakeOfficeRule = {
  kind: "state" | "zip";
  value: string;
  location_id: string;
};

/** The table the rules live in (20261006170000). */
export const INTAKE_OFFICE_RULES_TABLE = "intake_office_rules";

/**
 * Rows as the database returns them, to rules the matcher can use. A row of a
 * kind or shape the matcher does not know is dropped rather than guessed at.
 */
export function rulesFromRows(rows: unknown): IntakeOfficeRule[] {
  if (!Array.isArray(rows)) return [];
  const out: IntakeOfficeRule[] = [];
  for (const raw of rows as Record<string, unknown>[]) {
    const kind = raw?.match_kind;
    const value = typeof raw?.match_value === "string" ? raw.match_value.trim() : "";
    const locationId = typeof raw?.location_id === "string" ? raw.location_id : "";
    if (!locationId) continue;
    if (kind === "state" && isUsStateCode(value)) {
      out.push({ kind, value: value.toUpperCase(), location_id: locationId });
    } else if (kind === "zip" && normalizeZipPrefix(value)) {
      out.push({ kind, value, location_id: locationId });
    }
  }
  return out;
}

export type RoutingReason =
  "zip_rule" | "state_rule" | "nearest" | "locality" | "state" | "fallback" | "none";

export type RoutingMatch = {
  locationId: string | null;
  /** How the office was chosen — surfaced to triage as the reason for the guess. */
  reason: RoutingReason;
  /** What the rule matched on — the state code or the ZIP prefix. Rules only. */
  detail?: string;
};

const STATE_BY_NAME: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "district of columbia": "DC",
};

const STATE_CODES = new Set(Object.values(STATE_BY_NAME));

const titleCase = (name: string) => name.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Every state (and DC) as `{ code, name }`, by name — the Territory page's state picker. */
export const US_STATES: readonly { code: string; name: string }[] = Object.entries(STATE_BY_NAME)
  .map(([name, code]) => ({ code, name: titleCase(name) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/** True for a two-letter code a state rule may name. */
export function isUsStateCode(code: string | null | undefined): boolean {
  return STATE_CODES.has((code ?? "").trim().toUpperCase());
}

/**
 * The ZIP prefix a rule may hold: three to five digits. Three is the shortest
 * that means anything (a USPS sectional center — "185" is Scranton); fewer
 * would be a region of several states, which is what a state rule is for.
 */
export function normalizeZipPrefix(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").trim();
  return /^\d{3,5}$/.test(digits) ? digits : null;
}

/**
 * The property's five-digit ZIP: the type-ahead's structured one when the
 * customer picked a suggestion, else the last ZIP-shaped number in the typed
 * address. Taking the LAST match keeps "12345 Main St, Scranton, PA 18508" on
 * 18508 rather than on the house number.
 */
export function parseAddressZip(
  address: string | null | undefined,
  structured?: string | null,
): string | null {
  const given = (structured ?? "").trim().slice(0, 5);
  if (/^\d{5}$/.test(given)) return given;
  let found: string | null = null;
  for (const m of (address ?? "").matchAll(/\b(\d{5})(?:-\d{4})?\b/g)) found = m[1] ?? null;
  return found;
}

/**
 * The state named in a free-text address, as a two-letter code, or null.
 *
 * A two-letter code is trusted only when it looks like the state slot of an
 * address — followed by a ZIP, a comma, or the end of the string — so "12 ME
 * Street" or a street named "Ave IN" is not read as Maine or Indiana. A spelled
 * out state name is trusted anywhere; nobody names a street "New Jersey Ave"
 * outside New Jersey often enough to matter for a lead that a human confirms.
 */
export function parseAddressState(address: string | null | undefined): string | null {
  const text = (address ?? "").trim();
  if (!text) return null;

  // Last matching code wins: "NJ Transit Way, Brooklyn, NY 11210" is New York.
  const codeRe = /(?:^|[\s,])([A-Za-z]{2})(?=\s*(?:,|\d{5}(?:-\d{4})?\b|$))/g;
  let found: string | null = null;
  for (const m of text.matchAll(codeRe)) {
    const code = (m[1] ?? "").toUpperCase();
    if (STATE_CODES.has(code)) found = code;
  }
  if (found) return found;

  const lower = text.toLowerCase();
  let best: { code: string; index: number } | null = null;
  for (const [name, code] of Object.entries(STATE_BY_NAME)) {
    const re = new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`);
    const hit = re.exec(lower);
    if (hit && (!best || hit.index > best.index)) best = { code, index: hit.index };
  }
  return best?.code ?? null;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Is the office's town named in the address as a whole word or phrase? */
function mentionsLocality(address: string, locality: string | null): boolean {
  const town = locality ? fold(locality) : "";
  if (!town) return false;
  const re = new RegExp(`(?:^|\\s)${town.replace(/\s+/g, "\\s+")}(?:\\s|$)`);
  return re.test(fold(address));
}

const placed = (lat: number | null | undefined, lon: number | null | undefined) =>
  typeof lat === "number" &&
  typeof lon === "number" &&
  Number.isFinite(lat) &&
  Number.isFinite(lon) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lon) <= 180 &&
  !(lat === 0 && lon === 0);

/** Great-circle distance in km. Plenty for "which of a handful of offices". */
export function distanceKm(a: RoutingPoint, b: RoutingPoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Read the property's point off the submitted form fields (`site_lat` /
 * `site_lon`, set only when a type-ahead suggestion was picked). Anything that
 * does not parse to a real coordinate is no point at all.
 */
export function routingPointFromFields(
  fields: Record<string, string | null | undefined>,
): RoutingPoint | null {
  const lat = Number.parseFloat(fields["site_lat"] ?? "");
  const lon = Number.parseFloat(fields["site_lon"] ?? "");
  return placed(lat, lon) ? { lat, lon } : null;
}

/**
 * Pick the office for an address.
 *
 * Rules come first, because a rule is a person saying who covers a place and
 * everything after it is the app guessing:
 *
 * R1. A ZIP rule whose prefix starts the property's ZIP — the longest prefix
 *     wins, so "18508 → office A" beats "185 → office B". A ZIP rule beats a
 *     state rule because it is narrower: it is how a split state ("north
 *     Jersey to Newark, the shore to Lakewood") is said.
 * R2. A state rule for the property's state.
 *     A rule naming an inactive or unknown office is skipped, not obeyed —
 *     closing an office must not start dropping its leads on the floor.
 *
 * The chase module's ZIP zones (Territory › Zones) are deliberately NOT read
 * here: a zone belongs to a market and its chasers, never to an office, so it
 * cannot say which office a lead is for.
 *
 * Then the address alone:
 *
 * 0. With a point: the closest placed office — within the property's state
 *    when that state has one. The state still wins over raw distance because
 *    each office bills under its own state's legal entity, and a Jersey City
 *    job sent to Brooklyn for being two miles nearer is a job the wrong entity
 *    invoices. `region` is the type-ahead's structured state when known.
 * 1. Offices in the address's state whose town is named in the address.
 * 2. Any office in that state — the first by code, so the choice is stable.
 * 3. The configured fallback office.
 * 4. Nothing — the submission stays unrouted and privileged staff triage it.
 * Inactive offices are never chosen.
 */
export function matchLocationForAddress(
  address: string | null | undefined,
  locations: readonly RoutableLocation[],
  fallbackLocationId?: string | null,
  where?: {
    point?: RoutingPoint | null;
    region?: string | null;
    /** The type-ahead's structured ZIP, when a suggestion was picked. */
    postalCode?: string | null;
    rules?: readonly IntakeOfficeRule[];
  },
): RoutingMatch {
  const active = locations.filter((l) => l.active !== false);
  const text = (address ?? "").trim();
  const hinted = (where?.region ?? "").trim().toUpperCase();
  const state = STATE_CODES.has(hinted) ? hinted : parseAddressState(text);

  const ruled = matchOfficeRule(where?.rules ?? [], active, {
    state,
    zip: parseAddressZip(text, where?.postalCode),
  });
  if (ruled) return ruled;

  const point = where?.point;
  if (point) {
    const withPoint = active.filter((l) => placed(l.lat, l.lon));
    const inState = state
      ? withPoint.filter((l) => (l.region ?? "").trim().toUpperCase() === state)
      : [];
    const pool = inState.length ? inState : withPoint;
    let best: { id: string; km: number; code: string } | null = null;
    for (const l of pool) {
      const km = distanceKm(point, { lat: l.lat as number, lon: l.lon as number });
      // Ties go to the lower code, so the same address always lands the same way.
      if (!best || km < best.km || (km === best.km && l.code.localeCompare(best.code) < 0)) {
        best = { id: l.id, km, code: l.code };
      }
    }
    if (best) return { locationId: best.id, reason: "nearest" };
  }

  if (state) {
    const inState = active
      .filter((l) => (l.region ?? "").trim().toUpperCase() === state)
      .sort((a, b) => a.code.localeCompare(b.code));
    const byTown = inState.find((l) => mentionsLocality(text, l.locality));
    if (byTown) return { locationId: byTown.id, reason: "locality" };
    if (inState[0]) return { locationId: inState[0].id, reason: "state" };
  }

  const fallback = fallbackLocationId ? active.find((l) => l.id === fallbackLocationId) : undefined;
  if (fallback) return { locationId: fallback.id, reason: "fallback" };
  return { locationId: null, reason: "none" };
}

/** R1 and R2 of `matchLocationForAddress`; null when no usable rule covers the property. */
function matchOfficeRule(
  rules: readonly IntakeOfficeRule[],
  active: readonly RoutableLocation[],
  where: { state: string | null; zip: string | null },
): RoutingMatch | null {
  const usable = (r: IntakeOfficeRule) => active.some((l) => l.id === r.location_id);

  if (where.zip) {
    let best: { rule: IntakeOfficeRule; prefix: string } | null = null;
    for (const rule of rules) {
      const prefix = rule.kind === "zip" ? normalizeZipPrefix(rule.value) : null;
      if (!prefix || !where.zip.startsWith(prefix) || !usable(rule)) continue;
      if (!best || prefix.length > best.prefix.length) best = { rule, prefix };
    }
    if (best) {
      return { locationId: best.rule.location_id, reason: "zip_rule", detail: best.prefix };
    }
  }

  if (where.state) {
    const rule = rules.find(
      (r) => r.kind === "state" && r.value.trim().toUpperCase() === where.state && usable(r),
    );
    if (rule) return { locationId: rule.location_id, reason: "state_rule", detail: where.state };
  }
  return null;
}

/** The routing reasons the database may hold; anything else reads as an older row. */
const KNOWN_REASONS = new Set<string>([
  "zip_rule",
  "state_rule",
  "nearest",
  "locality",
  "state",
  "fallback",
  "none",
]);

/**
 * The tail of the inbox's office badge: WHY this office, so a reviewer can
 * trust it or correct it. "NY-UP · NY-Upstate · from state rule (PA)" says a
 * person decided PA goes Upstate; "from address (nearest)" says only that
 * Upstate was the closest office on the map, which for Scranton is a guess.
 *
 * `reason` is null on a row routed before 20261006170000 (or while it is not
 * applied) — those keep the old "from address", which is all they ever knew.
 * A submission a person routed (an office's own link) has no tail at all.
 */
export function routingBadgeSuffix(
  autoAssigned: boolean,
  reason: string | null | undefined,
  detail: string | null | undefined,
): string {
  if (!autoAssigned) return "";
  const known = reason && KNOWN_REASONS.has(reason) ? (reason as RoutingReason) : null;
  const what = (detail ?? "").trim();
  switch (known) {
    case "zip_rule":
      return what ? `from ZIP rule (${what})` : "from ZIP rule";
    case "state_rule":
      return what ? `from state rule (${what})` : "from state rule";
    case "nearest":
      return "from address (nearest)";
    case "locality":
      return "from address (town)";
    case "state":
      return "from address (state)";
    case "fallback":
      return "default office";
    default:
      return "from address";
  }
}

/**
 * `matchLocationForAddress` fed from a submission's own fields — the typed
 * address plus whatever the type-ahead added. The public submit and the
 * re-match after a rule change both route through here, so a lead lands the
 * same way whichever of the two placed it.
 */
export function matchLocationForFields(
  fields: Record<string, string | null | undefined>,
  locations: readonly RoutableLocation[],
  fallbackLocationId: string | null | undefined,
  rules: readonly IntakeOfficeRule[],
): RoutingMatch {
  return matchLocationForAddress(fields["site_address"] ?? null, locations, fallbackLocationId, {
    point: routingPointFromFields(fields),
    region: fields["site_region"] ?? null,
    postalCode: fields["site_postal_code"] ?? null,
    rules,
  });
}

export type RematchCandidate = {
  id: string;
  job_id: string | null;
  status: string;
  fields: Record<string, string | null>;
  location_id: string | null;
  location_auto_assigned: boolean;
  location_route_reason: string | null;
  location_route_detail: string | null;
  /** The link it came through. Only a general link is ever routed by address. */
  request: {
    job_id: string | null;
    location_id: string | null;
    tradeshow_id: string | null;
  } | null;
};

export type RematchChange = {
  id: string;
  locationId: string | null;
  reason: RoutingReason;
  detail: string | null;
};

/**
 * Which waiting intake forms move when the rules change, and to where.
 *
 * Adding "PA → NY-Upstate" should fix the Scranton lead that is already
 * sitting in the inbox, not only the next one — so after a rule is saved the
 * waiting forms are routed again under the new rules. Only forms the ADDRESS
 * placed are touched:
 *  - still waiting: no job yet and still pending. A form that became a job, or
 *    was attached or dismissed, is history and is never moved;
 *  - from a general link (the website button or a standing link). A form sent
 *    through an office's own link, a job's link or a show's link was placed by
 *    a person when the link was made;
 *  - auto-assigned, or not placed at all. A form with an office and
 *    `location_auto_assigned` false is a person's choice — the quick switch on
 *    the intake card — and a person's choice beats every rule.
 * Only rows whose office or reason would change are returned.
 */
export function planIntakeRematch(
  rows: readonly RematchCandidate[],
  locations: readonly RoutableLocation[],
  fallbackLocationId: string | null | undefined,
  rules: readonly IntakeOfficeRule[],
): RematchChange[] {
  const changes: RematchChange[] = [];
  for (const row of rows) {
    if (row.job_id || row.status !== "pending") continue;
    const r = row.request;
    if (!r || r.job_id || r.location_id || r.tradeshow_id) continue;
    if (row.location_id && !row.location_auto_assigned) continue;

    const match = matchLocationForFields(row.fields ?? {}, locations, fallbackLocationId, rules);
    const detail = match.detail ?? null;
    if (
      match.locationId === row.location_id &&
      match.reason === row.location_route_reason &&
      detail === (row.location_route_detail ?? null)
    ) {
      continue;
    }
    changes.push({ id: row.id, locationId: match.locationId, reason: match.reason, detail });
  }
  return changes;
}
