import type { AppRole } from "./roles";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const ASSIGNABLE_ROLES: AppRole[] = [
  "owner",
  "admin",
  // The break-glass role. It has to be assignable from the user page: it is the
  // guaranteed way back into Settings → Access, and the lockout confirm tells
  // an administrator to hand it to somebody before saving. A recovery role that
  // could only ever be granted in SQL would not be much of a recovery.
  "dev",
  "regional",
  "location_manager",
  "sales_manager",
  "sales_rep",
  "field_chaser",
  "crew",
];

/**
 * Legacy roles remain in the enum for old data but should not be
 * newly assigned from the admin UI.
 */
export const LEGACY_ROLES: AppRole[] = ["office", "field"];

export type LocationMemberRole = "manager" | "office" | "field";

export const LOCATION_MEMBER_ROLES: LocationMemberRole[] = ["manager", "office", "field"];

export const LOCATION_MEMBER_ROLE_LABEL: Record<LocationMemberRole, string> = {
  manager: "Manager",
  office: "Office",
  field: "Field",
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  role_granted: "Role granted",
  role_revoked: "Role revoked",
  location_added: "Location added",
  location_removed: "Location removed",
  location_role_changed: "Location role changed",
  region_added: "Region added",
  region_removed: "Region removed",
  activated: "Reactivated",
  deactivated: "Deactivated",
  role_permission_added: "Role rule added",
  role_permission_removed: "Role rule removed",
  user_permission_added: "Personal override added",
  user_permission_removed: "Personal override cleared",
  user_permission_changed: "Personal override changed",
  // Names the first audit trigger emitted before the check constraint
  // narrowed the vocabulary. None exist in production, but a row is a row.
  permission_granted: "Personal override added",
  permission_revoked: "Personal override added",
  permission_removed: "Personal override cleared",
  permission_changed: "Personal override changed",
};

export function relTime(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts).getTime();
  const diff = Date.now() - d;
  const day = 86_400_000;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(DATE_LOCALE, US_DATE);
}
