import { TOUCHPOINT_LABEL } from "@/lib/accounts";
import { JOB_LOSS_LABELS, JOB_STATUS_LABELS, JOB_STATUS_TONE } from "@/lib/jobs";
import type { MapJob } from "@/lib/map-jobs";
import type { PlannableStop, Visit } from "@/lib/visits";

/**
 * What the card that opens on a Field map pin says. Mark, looking at the
 * Routes map on his phone:
 *
 *   "make the circles clickable to see details"
 *
 * and then, sending a Pipedrive map with a contact card open above a pin:
 *
 *   "this is how pipedrive does it, which shows the contacts and their
 *    locations - and it should show the current stage in the pipeline and
 *    who the salesman is."
 *
 * So the card has Pipedrive's shape: the contact and company as one link on
 * the first line, then Stage and Salesman, then email and phone as links,
 * then the street address. Before this a tap on a deal or client pin
 * silently added it to the route — fine on a desktop with the stops list in
 * view, useless in a car where the pin is a coloured dot and nothing says
 * whose it is. Now a tap opens this card and the add is a button inside it,
 * so a stop is still one tap away and is never added by accident.
 *
 * This file is only the derivation — pin in, lines out — so it is testable
 * without a map. Everything it reads is already on the page: the stops the
 * planner lists, the visits the "By day" tab lists, the jobs layer and the
 * offices the camera centres on. Nothing is fetched for a tap.
 */

export type PinKind = "deal" | "client" | "job" | "visit" | "office";

export const PIN_KIND_LABEL: Record<PinKind, string> = {
  deal: "Deal",
  client: "Client",
  job: "Job",
  visit: "Past visit",
  office: "Office",
};

/** Where the first line of the card links to. */
export type PinTarget = { kind: "account"; id: string } | { kind: "job"; id: string };

export type PinDetailRow = {
  label: string;
  value: string;
  /** A coloured dot before the value — a pipeline stage or health band. */
  dot?: string | null;
  /** An initials chip before the value, the way the board card shows the rep. */
  avatar?: boolean;
  /** A status pill, in the job status tone classes. */
  pill?: string;
  /** mailto: / tel: — the value is a link. */
  href?: string;
  /** An in-app link (the customer on a job card). */
  to?: PinTarget;
  /** "never visited" reads in the warning tone the stops list uses. */
  tone?: "warning";
};

export type PinDetails = {
  kind: PinKind;
  kindLabel: string;
  /** Line one: "Contact · Company", "#1234 · 12 Main St", the office name. */
  title: string;
  /** What line one links to; null for an office. */
  target: PinTarget | null;
  rows: PinDetailRow[];
  address: string | null;
  /** What Directions navigates to — the address, or "lat,lon" for a visit. */
  directionsTo: string | null;
  /** The planner stop "Add to route" toggles; null when the pin is not plannable. */
  stopId: string | null;
};

/** A marker id on the Field map, decoded. Clusters are not pins. */
export type PinRef =
  | { kind: "stop"; id: string }
  | { kind: "job"; id: string }
  | { kind: "visit"; id: string }
  | { kind: "office"; id: string }
  | { kind: "cluster"; id: string };

/**
 * Marker ids on the Routes map carry their kind as a prefix — `stop:`,
 * `job:`, `office-`, `cluster:` — except past visits, which are the bare
 * touchpoint id. Anything unprefixed is therefore a visit.
 */
export function parsePinId(id: string): PinRef {
  if (id.startsWith("cluster:")) return { kind: "cluster", id };
  if (id.startsWith("stop:")) return { kind: "stop", id: id.slice("stop:".length) };
  if (id.startsWith("job:")) return { kind: "job", id: id.slice("job:".length) };
  if (id.startsWith("office-")) return { kind: "office", id: id.slice("office-".length) };
  return { kind: "visit", id };
}

/** "Yossi Burger · IB YBI Coverage" — person then company; company alone if no contact. */
export function contactTitle(contact: string | null, company: string): string {
  return contact ? `${contact} · ${company}` : company;
}

const day = (iso: string) => iso.slice(0, 10);

/** The lines a deal and a client share: contact links, rep, last visit, address. */
function accountRows(s: PlannableStop, opts: { neverTone: boolean }): PinDetailRow[] {
  const rows: PinDetailRow[] = [];
  rows.push({ label: "Salesman", value: s.owner_name ?? "Unassigned", avatar: !!s.owner_name });
  if (s.email) rows.push({ label: "Email", value: s.email, href: `mailto:${s.email}` });
  if (s.phone) rows.push({ label: "Phone", value: s.phone, href: `tel:${s.phone}` });
  rows.push(
    s.last_in_person_at
      ? { label: "Last visit", value: day(s.last_in_person_at) }
      : {
          label: "Last visit",
          value: "never visited",
          tone: opts.neverTone ? "warning" : undefined,
        },
  );
  return rows;
}

/**
 * A deal: the pipeline stage with the board's colour dot, the salesman, and
 * whether anyone has driven out to it — "never visited" is the gap the whole
 * page exists to close, so it keeps the warning treatment it has in the rows.
 */
export function dealPinDetails(s: PlannableStop): PinDetails {
  const rows: PinDetailRow[] = [
    { label: "Stage", value: s.stage_name ?? "Prospecting", dot: s.stage_color ?? null },
    ...accountRows(s, { neverTone: true }),
  ];
  return {
    kind: "deal",
    kindLabel: PIN_KIND_LABEL.deal,
    title: contactTitle(s.contact_name, s.name),
    target: { kind: "account", id: s.id },
    rows,
    address: s.address,
    directionsTo: s.address,
    stopId: s.id,
  };
}

/**
 * A client: the health band in place of the stage. A client with no band set
 * by hand simply has no band row — the computed verdict needs the whole
 * touch history and is not something a map tap should go and fetch. A client
 * with no visit on record is a fact, not an alarm, so it reads plain.
 */
export function clientPinDetails(s: PlannableStop): PinDetails {
  const rows: PinDetailRow[] = [];
  if (s.health_name) rows.push({ label: "Health", value: s.health_name, dot: s.health_color });
  rows.push(...accountRows(s, { neverTone: false }));
  return {
    kind: "client",
    kindLabel: PIN_KIND_LABEL.client,
    title: contactTitle(s.contact_name, s.name),
    target: { kind: "account", id: s.id },
    rows,
    address: s.address,
    directionsTo: s.address,
    stopId: s.id,
  };
}

export function stopPinDetails(s: PlannableStop): PinDetails {
  return s.kind === "prospect" ? dealPinDetails(s) : clientPinDetails(s);
}

/**
 * A job: the number and address are the link, then status, the customer,
 * who sold it and who is running it, and what the loss was. Jobs are not
 * route stops — the planner plans around accounts — so there is no "Add to
 * route"; the customer link is how a rep gets to the account.
 */
export function jobPinDetails(j: MapJob): PinDetails {
  const rows: PinDetailRow[] = [
    {
      label: "Status",
      value: JOB_STATUS_LABELS[j.status] ?? j.status,
      pill: JOB_STATUS_TONE[j.status] ?? "bg-muted text-muted-foreground",
    },
  ];
  if (j.account_name) {
    rows.push({
      label: "Customer",
      value: j.account_name,
      to: j.account_id ? { kind: "account", id: j.account_id } : undefined,
    });
  }
  rows.push({ label: "Salesman", value: j.owner_name ?? "Unassigned", avatar: !!j.owner_name });
  if (j.pm_name) rows.push({ label: "PM", value: j.pm_name, avatar: true });
  if (j.loss_type) {
    rows.push({
      label: "Loss",
      value: JOB_LOSS_LABELS[j.loss_type as keyof typeof JOB_LOSS_LABELS] ?? j.loss_type,
    });
  }
  return {
    kind: "job",
    kindLabel: j.open ? "Open job" : "Closed job",
    title: j.job_number ? `#${j.job_number} · ${j.address}` : j.address,
    target: { kind: "job", id: j.id },
    rows,
    address: j.address,
    directionsTo: j.address,
    stopId: null,
  };
}

/** "Sep 12, 2026, 2:15 PM" — a rep reads a visit as a moment, not a date. */
export function formatVisitTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * A past visit: who went, when, what kind of touchpoint and what they wrote
 * down. The blue dot is context for planning — "someone was here two weeks
 * ago" — so the notes are the point of opening it. Its account can be added
 * to the route when it is one of the stops the planner knows about.
 */
export function visitPinDetails(
  v: Visit,
  whoName: string | null,
  opts: { plannable: boolean },
): PinDetails {
  const rows: PinDetailRow[] = [
    { label: "Who", value: whoName ?? "Unknown", avatar: !!whoName },
    { label: "When", value: formatVisitTime(v.occurred_at) },
    {
      label: "Type",
      value: TOUCHPOINT_LABEL[v.type as keyof typeof TOUCHPOINT_LABEL] ?? v.type,
    },
  ];
  if (v.notes?.trim()) rows.push({ label: "Notes", value: v.notes.trim() });
  return {
    kind: "visit",
    kindLabel: PIN_KIND_LABEL.visit,
    title: v.account_name ?? v.place_label ?? "Unlinked stop",
    target: v.account_id ? { kind: "account", id: v.account_id } : null,
    rows,
    address: v.place_label,
    directionsTo: v.place_label ?? `${v.lat},${v.lon}`,
    stopId: opts.plannable && v.account_id ? v.account_id : null,
  };
}

/**
 * An office: the gold pin the map centres on. Name, phone and address, with
 * Directions — an office is not a route stop, so there is nothing to add.
 */
export function officePinDetails(o: {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
}): PinDetails {
  const rows: PinDetailRow[] = [];
  if (o.phone) rows.push({ label: "Phone", value: o.phone, href: `tel:${o.phone}` });
  return {
    kind: "office",
    kindLabel: PIN_KIND_LABEL.office,
    title: o.name,
    target: null,
    rows,
    address: o.address,
    directionsTo: o.address,
    stopId: null,
  };
}
