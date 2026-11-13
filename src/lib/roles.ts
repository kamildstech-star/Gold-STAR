export const ALL_ROLES = [
  "owner",
  "admin",
  "dev",
  "regional",
  "location_manager",
  "sales_head",
  "sales_person",
  "outside_sales_rep",
  "cold_caller",
  "sales_manager",
  "sales_rep",
  "office",
  "field_chaser",
  "field",
  "crew",
] as const;

export type AppRole = (typeof ALL_ROLES)[number];

/** Highest -> lowest. Legacy office/field map onto their modern equivalents. */
export const ROLE_PRIORITY: AppRole[] = [
  "owner",
  "admin",
  "dev",
  "regional",
  "sales_head",
  "location_manager",
  "office",
  "sales_manager",
  "sales_person",
  "outside_sales_rep",
  "sales_rep",
  "cold_caller",
  "field_chaser",
  "field",
  "crew",
];

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: "Owner",
  admin: "Admin",
  dev: "Developer",
  // Display names only (Melly meeting, 21 Oct). The keys `regional` and
  // `location_manager` stay as they are: the database role enum, access rules
  // and stored memberships all use them.
  regional: "Regional Director",
  location_manager: "Project Manager",
  office: "Office (legacy)",
  sales_head: "Sales Head",
  sales_person: "Sales Person",
  outside_sales_rep: "Outside Sales Rep",
  cold_caller: "Cold Caller",
  sales_manager: "Sales Manager (legacy)",
  sales_rep: "Sales Rep (legacy)",
  field_chaser: "Field Chaser",
  field: "Field (legacy)",
  crew: "Crew",
};

export type DashboardKey =
  | "owner"
  | "regional"
  | "location_manager"
  | "sales_head"
  | "sales_person"
  | "outside_sales_rep"
  | "cold_caller"
  | "sales_manager"
  | "sales_rep"
  | "field_chaser"
  | "crew"
  | "admin";

export function primaryRole(roles: AppRole[]): AppRole | null {
  for (const r of ROLE_PRIORITY) if (roles.includes(r)) return r;
  return null;
}

export function dashboardFor(role: AppRole | null): DashboardKey | null {
  if (!role) return null;
  if (role === "office") return "location_manager";
  if (role === "field") return "field_chaser";
  if (role === "admin" || role === "dev") return "admin";
  // Owner and Sales Head share one dashboard: full sales overview.
  if (role === "sales_head") return "sales_head";
  // Legacy sales roles fold onto their modern equivalents.
  if (role === "sales_manager") return "sales_head";
  if (role === "sales_rep") return "sales_person";
  return role as DashboardKey;
}

/** admin, owner, or dev — full app access. */
export function isPrivileged(roles: AppRole[]) {
  return roles.includes("owner") || roles.includes("admin") || roles.includes("dev");
}

/**
 * The roles that actually sell: the people for whom a contact's birthday, gift
 * policy and personal preferences are the job rather than trivia.
 *
 * Managers are not here. A sales manager reviewing an account is reading it,
 * not building the relationship, and the point of asking is to decide what a
 * form opens with -- not what anyone may see. Nothing is hidden either way.
 */
export const SELLING_ROLES: AppRole[] = [
  "sales_person",
  "sales_rep",
  "outside_sales_rep",
  "cold_caller",
];

export function isSeller(roles: AppRole[]) {
  return roles.some((r) => SELLING_ROLES.includes(r));
}

/** Staff accounts (admin/owner/dev) never count in business reporting. */
export function isStaffAccount(roles: AppRole[]) {
  return isPrivileged(roles);
}

export function isMobileFirstRole(role: AppRole | null) {
  return role === "field_chaser" || role === "field" || role === "crew";
}

/**
 * Every modern role is previewable, whether or not a user holds it — the
 * point of role preview is inspecting the system without first creating a
 * person for each role. Legacy office/field are excluded.
 */
export const PREVIEWABLE_ROLES: AppRole[] = [
  "owner",
  "admin",
  "dev",
  "regional",
  "location_manager",
  "sales_head",
  "sales_person",
  "outside_sales_rep",
  "cold_caller",
  "field_chaser",
  "crew",
];

/** Anyone who sells: gets rep-grade restrictions (no money, no export). */
export const REP_ROLES: AppRole[] = [
  "sales_person",
  "outside_sales_rep",
  "cold_caller",
  "sales_rep",
  "field_chaser",
  "field",
  "crew",
];

/** Sales leadership — full sales visibility, export rights, approvals. */
export function isSalesLeadership(roles: AppRole[]) {
  return roles.includes("sales_head") || roles.includes("sales_manager") || isPrivileged(roles);
}

/** True when every role the user holds is a rep-grade role. */
export function isRepOnly(roles: AppRole[]) {
  if (roles.length === 0) return false;
  if (isSalesLeadership(roles)) return false;
  if (roles.includes("regional") || roles.includes("location_manager") || roles.includes("office"))
    return false;
  return roles.every((r) => REP_ROLES.includes(r));
}

/**
 * Which side a "Mine / All" toggle should start on. Oversight roles (owner,
 * admin, dev, regional, location manager, sales head/manager) own few records
 * themselves, so defaulting them to "Mine" shows an empty screen and reads as
 * missing data. Individual contributors still start on their own book.
 * Only the *default* — a saved choice always wins.
 */
export function defaultRecordScope(roles: AppRole[]): "mine" | "all" {
  if (roles.length === 0) return "mine";
  return isRepOnly(roles) ? "mine" : "all";
}

/**
 * Who runs Tradeshows: adds, edits and archives shows, and sees what a show
 * cost and returned. Melly (29 Oct): "return on the show, I don't want
 * salespeople to see, but it's great for me." Both tradeshow pages read this
 * one rule so the list and the show page cannot drift apart.
 */
export function canManageTradeshows(roles: AppRole[]) {
  return isSalesManager(roles);
}

/**
 * Who makes the day-30 decision on a Critical client and sees the manager's
 * Critical list: sales leadership and the office managers. Mirrors
 * `is_sales_manager()` in the database (migration 20261110160000), which is
 * what actually refuses the call — this only decides what the screen offers.
 */
export function isSalesManager(roles: AppRole[]) {
  return (
    isPrivileged(roles) ||
    roles.includes("sales_head") ||
    roles.includes("sales_manager") ||
    roles.includes("regional") ||
    roles.includes("location_manager")
  );
}

/** Money figures are only ever shown to non-rep roles. */
export function canSeeMoney(roles: AppRole[]) {
  return !isRepOnly(roles);
}

/** Export/download/API rights: Sales Head and Owner only (admin/dev for support). */
export function canExport(roles: AppRole[]) {
  return (
    roles.includes("owner") ||
    roles.includes("sales_head") ||
    roles.includes("admin") ||
    roles.includes("dev")
  );
}
