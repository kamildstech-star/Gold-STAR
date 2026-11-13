/**
 * What an outsider is allowed to see on a shared job link.
 *
 * A share link is opened by a homeowner, an adjuster or a property manager who
 * has no login and no relationship with this system, so the safe default is
 * that everything is hidden. Every switch here starts OFF except the two that
 * make the page mean anything at all — the job's own dates and a way to phone
 * us. A link created by someone clicking straight through therefore shows a
 * bare bar chart of when work runs, and nothing about who does it or what is
 * standing in the building.
 *
 * This module is deliberately pure. It is imported by the public server
 * function, by the create dialog and by the public page, and it must never
 * drag a Supabase client into any of them.
 */
import type { GanttBar } from "./job-gantt";
import type { PublicPhotoView } from "./photo-share";

export type ShareDisplayOptionKey =
  | "job_dates"
  | "response_time"
  | "job_number"
  | "address"
  | "crew"
  | "crew_names"
  | "equipment"
  | "equipment_tags"
  | "equipment_overdue"
  | "undated_note"
  | "contact";

export type ShareDisplayOptions = Record<ShareDisplayOptionKey, boolean>;

export type ShareDisplayOptionDef = {
  key: ShareDisplayOptionKey;
  label: string;
  /** Why an outsider seeing this could be a problem, in the sender's words. */
  hint: string;
  default: boolean;
  /** Meaningless unless its parent is on, so the UI nests and disables it. */
  requires?: ShareDisplayOptionKey;
};

export const SHARE_DISPLAY_OPTIONS: ShareDisplayOptionDef[] = [
  {
    key: "job_dates",
    label: "Job start and completion dates",
    hint: "The bar the whole schedule hangs off. With this off there may be nothing to draw.",
    default: true,
  },
  {
    key: "response_time",
    label: "Loss date and days to mobilize",
    hint: "Shows how long we took to get on site.",
    default: false,
  },
  {
    key: "job_number",
    label: "Job number",
    hint: "Our internal reference.",
    default: false,
  },
  {
    key: "address",
    label: "Property address",
    hint: "Fine for the homeowner, not always fine for whoever they forward the link to.",
    default: false,
  },
  {
    key: "crew",
    label: "Crew scheduled on site",
    hint: "One bar per assignment, showing when people are booked.",
    default: false,
  },
  {
    key: "crew_names",
    label: "Crew member names",
    hint: "Off shows the role instead — an adjuster does not need the technician's name.",
    default: false,
    requires: "crew",
  },
  {
    key: "equipment",
    label: "Equipment on site",
    hint: "How much gear is standing in the building, and for how long.",
    default: false,
  },
  {
    key: "equipment_tags",
    label: "Equipment asset tags",
    hint: "Off shows the type instead of our unit numbers.",
    default: false,
    requires: "equipment",
  },
  {
    key: "equipment_overdue",
    label: "Flag equipment past its pickup date",
    hint: "Marks gear we said we would collect and have not.",
    default: false,
    requires: "equipment",
  },
  {
    key: "undated_note",
    label: "Note about items with no dates",
    hint: 'The "not drawn" footnote advertises gaps in our own records.',
    default: false,
  },
  {
    key: "contact",
    label: "Our office name and phone number",
    hint: "So the recipient can call someone about what they are looking at.",
    default: true,
  },
];

export const SHARE_DISPLAY_DEFAULTS: ShareDisplayOptions = Object.fromEntries(
  SHARE_DISPLAY_OPTIONS.map((o) => [o.key, o.default]),
) as ShareDisplayOptions;

/**
 * Coerce whatever is in the jsonb column into the full option set.
 *
 * An unknown or absent key resolves to its default, and a dependent option is
 * forced off when its parent is off — so a link written by an older build, or
 * hand-edited in the database, can never end up permitting more than the UI
 * that created it could express.
 */
export function normalizeDisplayOptions(raw: unknown): ShareDisplayOptions {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...SHARE_DISPLAY_DEFAULTS };
  for (const def of SHARE_DISPLAY_OPTIONS) {
    const v = src[def.key];
    if (typeof v === "boolean") out[def.key] = v;
  }
  for (const def of SHARE_DISPLAY_OPTIONS) {
    if (def.requires && !out[def.requires]) out[def.key] = false;
  }
  return out;
}

/* ── redaction ──────────────────────────────────────────────────────────── */

/** Labels pulled off the source rows, so a hidden name can be swapped for one. */
export type ShareBarFallbacks = {
  /** Bar id → the role label for that crew assignment. */
  crewRole: Record<string, string>;
  /** Bar id → the equipment type label for that placement. */
  equipmentType: Record<string, string>;
};

/**
 * Strip a built chart down to what the link permits.
 *
 * This runs on the server, on bars built from the full rows, and what it
 * returns is the entire response body. Hiding a name here removes it from the
 * wire, not from the render — the recipient's network tab holds no more than
 * their screen does.
 */
export function redactGanttBars(
  bars: GanttBar[],
  opts: ShareDisplayOptions,
  fallbacks: ShareBarFallbacks,
): GanttBar[] {
  const out: GanttBar[] = [];
  for (const bar of bars) {
    if (bar.id === "job-response" && !opts.response_time) continue;
    if (bar.id === "job-span" && !opts.job_dates) continue;

    if (bar.id === "job-span" && !opts.job_number) {
      out.push({ ...bar, label: "Work on site" });
      continue;
    }

    if (bar.kind === "crew" && !opts.crew_names) {
      out.push({
        ...bar,
        label: fallbacks.crewRole[bar.id] ?? "Crew",
        /* The role has just become the label; repeating it below would read as
           two different facts about the same row. */
        sublabel: null,
      });
      continue;
    }

    if (bar.kind === "equipment") {
      const hideOverdue = bar.overdue && !opts.equipment_overdue;
      const next: GanttBar = {
        ...bar,
        ...(opts.equipment_tags
          ? {}
          : { label: fallbacks.equipmentType[bar.id] ?? "Equipment", sublabel: null }),
        ...(hideOverdue ? { overdue: false, note: "Still on site." } : {}),
      };
      out.push(next);
      continue;
    }

    out.push(bar);
  }
  return out;
}

/* ── the public payload ─────────────────────────────────────────────────── */

export type PublicShareBranding = {
  companyName: string;
  officeName: string | null;
  officePhone: string | null;
  officeLogoUrl: string | null;
};

export type PublicScheduleView = {
  bars: GanttBar[];
  /** The server's calendar day, so the "today" line does not drift per device. */
  today: number;
  /** Present only when the link permits the footnote and there is one to make. */
  undated: string | null;
  /** Sub-lists that failed to read. Never silently dropped. */
  unread: string[];
};

/** Everything every kind of share carries, so the shell can frame any of them. */
type PublicShareHeader = {
  status: "ok";
  branding: PublicShareBranding;
  /** Free text the sender wrote for the recipient. */
  note: string | null;
  expiresAt: string;
  jobNumber: string | null;
  address: string | null;
};

export type PublicSharePayload =
  | { status: "gone"; reason: "not_found" | "revoked" | "expired" }
  /** A real, live link whose kind this viewer cannot render yet. */
  | { status: "unsupported" }
  /** The link resolved but the data behind it could not be read. */
  | { status: "error" }
  | (PublicShareHeader & { kind: "job_schedule"; schedule: PublicScheduleView })
  | (PublicShareHeader & { kind: "job_photos"; photos: PublicPhotoView })
  /** One filed report, sent as a link (David, 13 Oct: the drying report). */
  | (PublicShareHeader & {
      kind: "job_drying_report";
      report: { name: string; filedAt: string; href: string };
    });

export function jobSharePath(token: string): string {
  return `/share/${token}`;
}
