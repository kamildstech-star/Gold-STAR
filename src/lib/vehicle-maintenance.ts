/**
 * Vehicle maintenance: what was done to a van and what is coming due on it.
 *
 * David, 24 Sep, on Fleet: per-vehicle maintenance records, and the dates
 * that must not lapse — inspection, registration, insurance, next service —
 * with his Fleet-Vehicle Info sheet (insurance policy, registration and
 * inspection dates) as the data it holds.
 *
 * The stages here are the SAME as run_vehicle_due_alerts
 * (20260928124000_vehicle_maintenance.sql): the badge on the fleet page and
 * the notification in the bell must never disagree about whether a van is
 * overdue.
 *
 * Pure: every function takes `now`, and none of them defaults it. This
 * feature is nothing but countdowns, and a test that pins a date and then
 * calls a function that quietly reads the wall clock passes the day it is
 * written and fails a month later.
 */
import { daysToExpiry, expiryPhrase } from "@/lib/vendors";
import { roundMoneyLoose } from "@/lib/money";

export const MAINTENANCE_KINDS = [
  { value: "service", label: "Service" },
  { value: "oil_change", label: "Oil change" },
  { value: "tires", label: "Tires" },
  { value: "brakes", label: "Brakes" },
  { value: "repair", label: "Repair" },
  { value: "inspection", label: "State inspection" },
  { value: "dot_inspection", label: "DOT inspection" },
  { value: "registration", label: "Registration" },
  { value: "insurance", label: "Insurance" },
  { value: "other", label: "Other" },
] as const;
export type MaintenanceKind = (typeof MAINTENANCE_KINDS)[number]["value"];

/**
 * What is tracked per van. `referenceLabel` / `providerLabel` name the
 * Fleet-Vehicle Info sheet's columns so typing it in (or importing it) is a
 * straight copy: policy number + carrier, plate + DMV, certificate + station.
 *
 * `paperwork` is the legal-to-drive set (Mark: "insurance, registration, etc,
 * with alerts for each vehicle to make sure nothing lapses"). Those LAPSE and
 * are worded like every other expiring document in the app; service is just
 * late. `optional` paperwork is not a gap when it is absent: a van under
 * 10,000 lb never needs a DOT inspection, so no row is the right answer for it.
 *
 * Deliberately NOT here: IFTA (only vehicles over 26,000 lb or three axles
 * crossing state lines — not a restoration van or box truck), emissions as a
 * separate date (NJ and NY test it inside the state inspection; in Illinois
 * the emissions test IS the inspection), and driver medical cards (the
 * driver's paperwork, not the van's).
 */
export const DUE_KINDS = [
  {
    value: "insurance",
    label: "Insurance",
    referenceLabel: "Policy number",
    providerLabel: "Carrier",
    paperwork: true,
    optional: false,
    hint: null,
  },
  {
    value: "registration",
    label: "Registration",
    referenceLabel: "Plate / registration no.",
    providerLabel: "Issued by",
    paperwork: true,
    optional: false,
    hint: null,
  },
  {
    value: "inspection",
    label: "State inspection",
    referenceLabel: "Certificate / sticker no.",
    providerLabel: "Inspection station",
    paperwork: true,
    optional: false,
    hint: "Includes emissions: NJ and NY test it at inspection; in Illinois this is the emissions test.",
  },
  {
    value: "dot_inspection",
    label: "DOT inspection",
    referenceLabel: "Report / decal no.",
    providerLabel: "Inspector / shop",
    paperwork: true,
    optional: true,
    hint: "Annual, for trucks over 10,000 lb GVWR crossing state lines. Leave blank for vans that don't need it.",
  },
  {
    value: "service",
    label: "Next service",
    referenceLabel: "Service type",
    providerLabel: "Shop",
    paperwork: false,
    optional: false,
    hint: null,
  },
] as const;
export type DueKind = (typeof DUE_KINDS)[number]["value"];

export const DEFAULT_WARN_DAYS = 30;
export const DEFAULT_WARN_MILES = 500;

export type MaintenanceRecord = {
  id: string;
  vehicle_id: string;
  performed_on: string;
  kind: string;
  odometer: number | null;
  cost: number | null;
  vendor: string | null;
  note: string | null;
};

export type DueItem = {
  id: string;
  vehicle_id: string;
  kind: string;
  due_on: string | null;
  due_odometer: number | null;
  warn_days: number;
  warn_miles: number;
  reference: string | null;
  provider: string | null;
  note: string | null;
};

export type DueState = "overdue" | "due_soon" | "ok";

export type DueStatus = {
  state: DueState;
  days: number | null;
  milesLeft: number | null;
  phrase: string;
};

/** The kinds that lapse — insurance, registration, state and DOT inspection. */
export const PAPERWORK_KINDS: readonly DueKind[] = DUE_KINDS.filter((k) => k.paperwork).map(
  (k) => k.value,
);
export const isPaperwork = (kind: string): boolean =>
  (PAPERWORK_KINDS as readonly string[]).includes(kind);

export const kindLabel = (kind: string): string =>
  DUE_KINDS.find((k) => k.value === kind)?.label ??
  MAINTENANCE_KINDS.find((k) => k.value === kind)?.label ??
  kind;

/** Odometers only go up, so the highest reading on record is the latest. */
export function latestOdometer(records: readonly Pick<MaintenanceRecord, "odometer">[]) {
  let best: number | null = null;
  for (const r of records) {
    if (r.odometer != null && (best == null || r.odometer > best)) best = r.odometer;
  }
  return best;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** One due item → overdue / due soon / ok, and the words for it. */
export function dueStatus(
  item: Pick<DueItem, "due_on" | "due_odometer" | "warn_days" | "warn_miles"> & {
    kind?: string;
  },
  opts: { now: Date; odometer?: number | null },
): DueStatus {
  const days = daysToExpiry(item.due_on, opts.now);
  const milesLeft =
    item.due_odometer != null && opts.odometer != null ? item.due_odometer - opts.odometer : null;

  const overdue = (days != null && days < 0) || (milesLeft != null && milesLeft < 0);
  const soon =
    (days != null && days <= item.warn_days) || (milesLeft != null && milesLeft <= item.warn_miles);

  let phrase: string;
  // Paperwork reads exactly like a contractor certificate on /compliance —
  // "Expires in 6 days", "Expired 3 days ago" — so a lapsing registration
  // and a lapsing COI are the same sentence wherever they appear.
  if (item.kind && isPaperwork(item.kind) && days != null) phrase = expiryPhrase(days);
  else if (days != null && days < 0) phrase = `Overdue by ${plural(-days, "day")}`;
  else if (milesLeft != null && milesLeft < 0) phrase = `Overdue by ${plural(-milesLeft, "mile")}`;
  else if (days === 0) phrase = "Due today";
  else if (days != null && days <= item.warn_days) phrase = `Due in ${plural(days, "day")}`;
  else if (milesLeft != null && milesLeft <= item.warn_miles)
    phrase = `Due in ${plural(milesLeft, "mile")}`;
  else if (days != null) phrase = `Due in ${plural(days, "day")}`;
  else if (item.due_odometer != null)
    phrase =
      milesLeft != null
        ? `Due in ${plural(milesLeft, "mile")}`
        : `Due at ${item.due_odometer.toLocaleString("en-US")} mi`;
  else phrase = "No due date";

  return { state: overdue ? "overdue" : soon ? "due_soon" : "ok", days, milesLeft, phrase };
}

export type VehicleDueRollup = {
  state: DueState;
  overdue: number;
  dueSoon: number;
  /** The most pressing item's words, e.g. "Insurance overdue by 3 days". */
  headline: string | null;
};

const RANK: Record<DueState, number> = { overdue: 0, due_soon: 1, ok: 2 };

/** A van's due items → the one badge the fleet list shows. */
export function vehicleDueRollup(
  items: readonly DueItem[],
  opts: { now: Date; odometer?: number | null },
): VehicleDueRollup {
  const scored = items
    .map((i) => ({ i, s: dueStatus(i, opts) }))
    .sort(
      (a, b) =>
        RANK[a.s.state] - RANK[b.s.state] ||
        (a.s.days ?? Number.POSITIVE_INFINITY) - (b.s.days ?? Number.POSITIVE_INFINITY),
    );
  const overdue = scored.filter((x) => x.s.state === "overdue").length;
  const dueSoon = scored.filter((x) => x.s.state === "due_soon").length;
  const top = scored[0];
  const state: DueState = overdue ? "overdue" : dueSoon ? "due_soon" : "ok";
  return {
    state,
    overdue,
    dueSoon,
    headline:
      top && top.s.state !== "ok"
        ? `${kindLabel(top.i.kind)} ${top.s.phrase.charAt(0).toLowerCase()}${top.s.phrase.slice(1)}`
        : null,
  };
}

/** Total spend on a van's records, to the cent. */
export function maintenanceSpend(records: readonly Pick<MaintenanceRecord, "cost">[]): number {
  return roundMoneyLoose(records.reduce((s, r) => s + Number(r.cost ?? 0), 0));
}
