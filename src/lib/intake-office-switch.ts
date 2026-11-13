/**
 * The quick office switch on an intake card: who may move a waiting form to
 * which office, and what the badge says once a person has.
 *
 * Mark, looking at a Scranton lead badged "NY-UP · NY-UPSTATE · FROM ADDRESS":
 * "give a way to switch the office quickly if they don't like the match".
 *
 * No new permission is invented for it. A waiting form that sits in an office
 * is written by whoever `can_manage_location` that office, and the row it
 * becomes must again be in an office they can manage — that is
 * intake_submissions_write (20260903223000), unchanged. So the picker offers
 * exactly the offices that predicate would accept, and nobody is offered an
 * office they could not then see. The database still decides; this only keeps
 * the menu from offering a move it would refuse.
 *
 * Pure — no Supabase, no React.
 */
import { isPrivileged, type AppRole } from "./roles";
import { routingBadgeSuffix } from "./intake-routing";

/** `can_manage_location`: members of the office holding one of these roles… */
export const OFFICE_MANAGER_ROLES = ["office", "location_manager", "sales_manager"] as const;
/** …or regional members of the office's region holding one of these. */
export const REGIONAL_MANAGER_ROLES = [...OFFICE_MANAGER_ROLES, "regional"] as const;

export type OfficeSwitchViewer = {
  roles: readonly AppRole[];
  memberships: readonly { location_id: string }[];
  regionMemberships: readonly string[];
};

export type SwitchableOffice = { id: string; code: string; name: string; region_ids: string[] };

const holds = (roles: readonly string[], wanted: readonly string[]) =>
  roles.some((r) => wanted.includes(r));

/** Mirrors public.can_manage_location(uid, office). */
export function canManageOffice(
  viewer: OfficeSwitchViewer,
  office: SwitchableOffice | undefined,
): boolean {
  if (!office) return false;
  if (isPrivileged([...viewer.roles])) return true;
  const member = viewer.memberships.some((m) => m.location_id === office.id);
  if (member && holds(viewer.roles, OFFICE_MANAGER_ROLES)) return true;
  const regional = office.region_ids.some((r) => viewer.regionMemberships.includes(r));
  return regional && holds(viewer.roles, REGIONAL_MANAGER_ROLES);
}

/**
 * Whether this viewer may move this form, and to where.
 *
 * A form with no office (a general link nothing matched) is privileged-only
 * in the database, so only they get the picker for it. A form in an office
 * this viewer cannot manage shows its badge but no picker: they could not
 * move it out, so offering the menu would only end in a refusal.
 */
export function officeSwitchChoices(
  viewer: OfficeSwitchViewer,
  offices: readonly SwitchableOffice[],
  currentOfficeId: string | null,
): { canSwitch: boolean; choices: SwitchableOffice[] } {
  const current = currentOfficeId ? offices.find((o) => o.id === currentOfficeId) : undefined;
  const mayLeave = currentOfficeId
    ? canManageOffice(viewer, current)
    : isPrivileged([...viewer.roles]);
  if (!mayLeave) return { canSwitch: false, choices: [] };
  const choices = offices
    .filter((o) => o.id !== currentOfficeId && canManageOffice(viewer, o))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { canSwitch: choices.length > 0, choices };
}

/**
 * The badge tail. A person's choice is said as theirs — "set by Dana", or
 * "set by you" — so a reviewer knows it is not a guess, and so nobody wonders
 * why a new rule did not move it. Otherwise it is why the address chose it.
 */
export function officeBadgeTail(
  row: {
    location_auto_assigned: boolean;
    location_route_reason: string | null;
    location_route_detail: string | null;
    location_set_by: string | null;
    location_set_by_name: string | null;
  },
  viewerId: string | null,
): string {
  if (row.location_set_by) {
    if (viewerId && row.location_set_by === viewerId) return "set by you";
    const name = (row.location_set_by_name ?? "").trim();
    return name ? `set by ${name}` : "set by hand";
  }
  return routingBadgeSuffix(
    row.location_auto_assigned,
    row.location_route_reason,
    row.location_route_detail,
  );
}
