/**
 * US states, and the one function that turns whatever is on a record into a
 * two-letter code.
 *
 * A state reaches the app by three different routes and they do not agree:
 *
 *  - the address autocomplete writes the SHORT form, because
 *    `address-search.server.ts` asks Google for `administrative_area_level_1`
 *    with `short = true` and strips Mapbox's `US-` prefix — so `jobs.region`
 *    and the calculator's `region` are already "NJ";
 *  - `accounts.state` is a free-typed box on the account form, so it holds
 *    "NJ", "N.J.", "new jersey" or "New Jersey " depending on who typed it;
 *  - the admin picker added for state price lists writes the code.
 *
 * A price list keyed on the state therefore cannot compare strings directly.
 * Everything is narrowed through `normalizeStateCode` before it is stored or
 * matched, so "New Jersey" on an account and "NJ" on a job land on the same
 * list. Anything unrecognised comes back null rather than a guess — a wrong
 * state silently prices a job off another state's agreement, which is worse
 * than falling through to the default catalog.
 */

export interface UsState {
  code: string;
  name: string;
}

/** The 50 states, DC and the territories Gold Star could plausibly work in. */
export const US_STATES: readonly UsState[] = [
  { code: "AL", name: "Alabama" },
  { code: "AK", name: "Alaska" },
  { code: "AZ", name: "Arizona" },
  { code: "AR", name: "Arkansas" },
  { code: "CA", name: "California" },
  { code: "CO", name: "Colorado" },
  { code: "CT", name: "Connecticut" },
  { code: "DE", name: "Delaware" },
  { code: "DC", name: "District of Columbia" },
  { code: "FL", name: "Florida" },
  { code: "GA", name: "Georgia" },
  { code: "HI", name: "Hawaii" },
  { code: "ID", name: "Idaho" },
  { code: "IL", name: "Illinois" },
  { code: "IN", name: "Indiana" },
  { code: "IA", name: "Iowa" },
  { code: "KS", name: "Kansas" },
  { code: "KY", name: "Kentucky" },
  { code: "LA", name: "Louisiana" },
  { code: "ME", name: "Maine" },
  { code: "MD", name: "Maryland" },
  { code: "MA", name: "Massachusetts" },
  { code: "MI", name: "Michigan" },
  { code: "MN", name: "Minnesota" },
  { code: "MS", name: "Mississippi" },
  { code: "MO", name: "Missouri" },
  { code: "MT", name: "Montana" },
  { code: "NE", name: "Nebraska" },
  { code: "NV", name: "Nevada" },
  { code: "NH", name: "New Hampshire" },
  { code: "NJ", name: "New Jersey" },
  { code: "NM", name: "New Mexico" },
  { code: "NY", name: "New York" },
  { code: "NC", name: "North Carolina" },
  { code: "ND", name: "North Dakota" },
  { code: "OH", name: "Ohio" },
  { code: "OK", name: "Oklahoma" },
  { code: "OR", name: "Oregon" },
  { code: "PA", name: "Pennsylvania" },
  { code: "PR", name: "Puerto Rico" },
  { code: "RI", name: "Rhode Island" },
  { code: "SC", name: "South Carolina" },
  { code: "SD", name: "South Dakota" },
  { code: "TN", name: "Tennessee" },
  { code: "TX", name: "Texas" },
  { code: "UT", name: "Utah" },
  { code: "VT", name: "Vermont" },
  { code: "VA", name: "Virginia" },
  { code: "VI", name: "U.S. Virgin Islands" },
  { code: "WA", name: "Washington" },
  { code: "WV", name: "West Virginia" },
  { code: "WI", name: "Wisconsin" },
  { code: "WY", name: "Wyoming" },
];

const BY_CODE = new Map(US_STATES.map((s) => [s.code, s]));

/**
 * A name reduced to its letters and single spaces, applied to BOTH sides of
 * the lookup — otherwise "U.S. Virgin Islands" normalizes to "u s virgin
 * islands" and never matches the entry it came from.
 */
function nameKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
}

const BY_NAME = new Map(US_STATES.map((s) => [nameKey(s.name), s.code]));

export function stateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toUpperCase())?.name ?? null;
}

/**
 * "NJ", "nj", "N.J.", "New Jersey", " new  jersey " -> "NJ". Anything else,
 * including an empty box and a country that is not the US, -> null.
 *
 * Punctuation and doubled spaces are stripped before the name lookup for the
 * same reason the duplicate-detection rule strips them: they are typing, not
 * a different place.
 */
export function normalizeStateCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  // No state has a digit in it. Without this, stripping punctuation turns
  // "NJ1" into "NJ" and prices a job off New Jersey's agreement.
  if (/\d/.test(raw)) return null;

  // "N.J." and "N J" are both the code with typing in the way.
  const compact = raw.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (compact.length === 2 && BY_CODE.has(compact)) return compact;

  return BY_NAME.get(nameKey(raw)) ?? null;
}
