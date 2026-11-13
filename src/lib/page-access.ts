import type { EffectivePermission } from "./permissions";
import { ALL_ROLES, isPrivileged, type AppRole } from "./roles";

/**
 * PAGE-LEVEL ACCESS — the catalogue and the resolution rules
 * ==========================================================
 *
 * This module is deliberately free of React and of any database client: it is
 * the one place the decision lives, it is what the tests point at, and it is
 * what `scripts/gen-page-access-seed.ts` imports to emit the seed migration.
 * The React hook that feeds it live data is in `use-page-access.ts`.
 *
 * Staff think in pages ("a field guy shouldn't see the sales portal"), not in
 * capability keys. This layer gives every route under `_authenticated` a named
 * page, and lets a role either reach it or not.
 *
 * It is NOT a second permission system. A page is a row in the SAME
 * `permissions` catalogue every capability already lives in, with its key
 * namespaced `page.<id>`. That means:
 *
 *   - role defaults live in `role_permissions`, same table, same writes;
 *   - a personal grant/revoke in `user_permissions` works on a page for free,
 *     including expiry, reason and granted_by;
 *   - `effective_permissions()` already resolves and labels the source, so the
 *     database and the client cannot disagree about precedence;
 *   - adding a page never requires a new table, column or RPC.
 *
 * Precedence, with exactly one thing above it:
 *   BREAK-GLASS ROLE  >  personal revoke  >  personal grant  >  role default
 *                                                            >  built-in default
 * Owner and Admin are ordinary rows and the three essential pages are ordinary
 * rows, because Mark asked for a screen where everything is togglable. The one
 * exception is `dev`, the recovery role: since everything else can be switched
 * off, something has to stay on, or the Access screen can be switched away from
 * everybody with no way back except SQL. See `BREAK_GLASS_ROLE` below.
 * See `resolvePageAccess` for what happens when nothing is stored.
 *
 * WHAT THIS IS NOT: security for the data. Row-level security in the database
 * is the real boundary. Page gating decides which screens a person can open,
 * which is a routing and interface concern. A page that leaks data to someone
 * who forges a request is an RLS problem and has to be fixed there.
 */

/** Namespace that separates page keys from capability keys in `permissions`. */
export const PAGE_KEY_PREFIX = "page.";

export function pagePermissionKey(pageId: string): string {
  return `${PAGE_KEY_PREFIX}${pageId}`;
}

export function isPagePermissionKey(key: string): boolean {
  return key.startsWith(PAGE_KEY_PREFIX);
}

// ------------------------------------------------------------- break-glass

/**
 * The recovery role. One role, `dev`, that always reaches every page and every
 * capability, decided here in code ahead of any stored row.
 *
 * It exists because everything else is a switch. Once Owner and Admin became
 * ordinary editable rows, the Access screen could be switched off for every
 * role and there was no way back through the app at all — recovery meant raw
 * SQL against production. `dev` is the way back: switch off whatever you like,
 * and somebody holding this role can still sign in and put it right.
 *
 * Deliberately absolute. A cleared role row does not remove it, a personal
 * revoke does not override it, and neither does the Access screen, which draws
 * it read-only. A break-glass with an exception is not a break-glass. The
 * database enforces the same thing from its own side — see
 * `supabase/migrations/20260909190000_dev_break_glass.sql` — so the guarantee
 * is not merely a claim the interface makes.
 *
 * The escape hatch from the escape hatch is the role assignment itself: taking
 * `dev` off a person is an ordinary change on their user page.
 */
export const BREAK_GLASS_ROLE: AppRole = "dev";

/** Why the Access screen refuses to edit it. Rendered beside the padlock. */
export const BREAK_GLASS_REASON =
  "The recovery role. Always reaches every page so the Access screen can never be locked out.";

/** True when this identity holds the recovery role. */
export function isBreakGlass(roles: readonly AppRole[]): boolean {
  return roles.includes(BREAK_GLASS_ROLE);
}

export type PageArea =
  "Overview" | "Customers" | "Sales" | "Chase" | "Operations" | "Insight" | "Team" | "Admin";

/** Display order for areas; also the order the management screen renders. */
export const PAGE_AREAS: PageArea[] = [
  "Overview",
  "Customers",
  "Sales",
  "Chase",
  "Operations",
  "Insight",
  "Team",
  "Admin",
];

export type PageDef = {
  /** Stable id. Never rename — it is half of the stored permission key. */
  id: string;
  /** Route path this page owns. Child paths inherit it by prefix. */
  path: string;
  label: string;
  area: PageArea;
  /**
   * Roles that reach this page when nothing is stored for it. These reproduce
   * today's sidebar so that an unseeded database behaves exactly as the app
   * does now — see `resolvePageAccess` rule 4.
   */
  defaultRoles: readonly AppRole[];
  /**
   * Essential: a screen whose loss leaves someone with no landing page or no
   * way to manage their own account. It is NOT a lock — a stored row switches
   * it off like any other page. It only changes what happens when NOTHING is
   * stored (rule 2 below) and when the access answer cannot be fetched at all,
   * so that an unseeded database or a failed request never yields a blank app.
   */
  essential?: true;
  /**
   * Owns its own address only, never the subtree beneath it.
   *
   * Almost every page wants the opposite — `/farming` deciding for
   * `/farming/campaigns` is what keeps this catalogue short. Jobs is the
   * exception: the module at `/jobs` is management's, while `/jobs/<id>` is
   * the record a seller opens from their own commission or dashboard. One
   * entry cannot say both, so the list marks itself exact and a second,
   * ordinary entry covers what lies below.
   */
  exact?: true;
  /** Longer explanation for the management screen. */
  note?: string;
};

const MGMT: readonly AppRole[] = [
  "owner",
  "admin",
  "dev",
  "regional",
  "location_manager",
  "office",
  "sales_manager",
  "sales_head",
];

const PRIVILEGED: readonly AppRole[] = ["owner", "admin", "dev"];

const EVERYONE: readonly AppRole[] = ALL_ROLES;

const SELLERS: readonly AppRole[] = [
  "sales_person",
  "sales_rep",
  "outside_sales_rep",
  "cold_caller",
];

/** Reps who own relationships after the first cold-call handoff. */
const RELATIONSHIP_SELLERS: readonly AppRole[] = ["sales_person", "sales_rep", "outside_sales_rep"];

const FIELD: readonly AppRole[] = ["field_chaser", "field", "crew"];

/**
 * The page catalogue. Only pages that need their own decision are listed;
 * every other route inherits the longest registered path that prefixes it, so
 * `/jobs/abc123` follows `/jobs` and `/farming/campaigns` follows `/farming`.
 *
 * `defaultRoles` mirrors the sidebar for anything the sidebar shows. Detail
 * screens that the sidebar never lists (a job, an account, a contract) stay
 * open to everyone by default, because that is what they are today — RLS, not
 * the router, is what stops a crew member reading someone else's job.
 */
export const PAGES: readonly PageDef[] = [
  // ---------------------------------------------------------------- Overview
  {
    id: "dashboard",
    path: "/",
    label: "Dashboard",
    area: "Overview",
    defaultRoles: EVERYONE,
    essential: true,
    note: "Everyone's landing page. Switch it off and this role lands on a refusal instead.",
  },
  {
    id: "notifications",
    path: "/notifications",
    label: "Notifications",
    area: "Overview",
    defaultRoles: EVERYONE,
    essential: true,
    note: "Switch it off and this role cannot open or clear its own notifications.",
  },
  {
    id: "account-security",
    path: "/security",
    label: "My account security",
    area: "Overview",
    defaultRoles: EVERYONE,
    essential: true,
    note:
      "A person's own two-factor settings. Switch it off and these users cannot set up, " +
      "change or recover their own 2FA — an administrator has to do it for them.",
  },
  {
    id: "activity-history",
    path: "/history",
    label: "Activity history",
    area: "Overview",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "feature-requests",
    path: "/feature-requests",
    label: "Feature requests",
    area: "Overview",
    defaultRoles: [...MGMT, "sales_rep", ...FIELD],
  },

  // --------------------------------------------------------------- Customers
  {
    id: "customers",
    path: "/customers",
    label: "Customers",
    area: "Customers",
    defaultRoles: [...MGMT, "sales_rep", "field"],
  },
  {
    id: "accounts",
    path: "/accounts",
    label: "Accounts",
    area: "Customers",
    defaultRoles: [...MGMT, ...SELLERS, "field", "field_chaser"],
  },
  {
    id: "contacts",
    path: "/contacts",
    label: "Contacts",
    area: "Customers",
    defaultRoles: [...MGMT, ...SELLERS, "field", "field_chaser"],
  },
  {
    // 5 Nov: one building a client manages, opened from a person's building
    // count. The same people who can open the company.
    id: "buildings",
    path: "/buildings",
    label: "Buildings",
    area: "Customers",
    defaultRoles: [...MGMT, ...SELLERS, "field", "field_chaser"],
  },

  // ------------------------------------------------------------------- Sales
  {
    id: "pipeline",
    path: "/pipeline",
    label: "Pipeline",
    area: "Sales",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS],
  },
  {
    id: "active-clients",
    path: "/farming",
    label: "Active Clients",
    area: "Sales",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS],
  },
  {
    id: "routes",
    path: "/routes",
    label: "Routes",
    area: "Sales",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS, "field"],
  },
  {
    id: "tradeshows",
    path: "/tradeshows",
    label: "Tradeshows",
    area: "Sales",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS],
  },
  {
    id: "leaderboard",
    path: "/leaderboard",
    label: "Leaderboard",
    area: "Sales",
    defaultRoles: [...MGMT, "sales_rep"],
  },
  {
    id: "team-goals",
    path: "/team-goals",
    label: "Team Goals",
    area: "Sales",
    defaultRoles: MGMT,
  },
  {
    id: "sales-director",
    path: "/sales-director",
    label: "Sales Director dashboard",
    area: "Sales",
    defaultRoles: MGMT,
    note: "Also gated by the sales_director.view capability.",
  },
  {
    id: "gifts",
    path: "/gifts",
    label: "Gifts",
    area: "Sales",
    defaultRoles: [...MGMT, ...SELLERS],
  },
  {
    id: "networks",
    path: "/networks",
    label: "Networks",
    area: "Sales",
    defaultRoles: MGMT,
  },

  // ------------------------------------------------------------------- Chase
  {
    id: "chase-cockpit",
    path: "/chase",
    label: "Chase cockpit",
    area: "Chase",
    defaultRoles: [...MGMT, "field_chaser", "field"],
  },
  {
    id: "chase-search",
    path: "/chase/search",
    label: "Chase search",
    area: "Chase",
    defaultRoles: MGMT,
  },
  {
    id: "chase-past-leads",
    path: "/chase/past-leads",
    label: "Past leads",
    area: "Chase",
    defaultRoles: [...MGMT, "field_chaser", "field"],
  },
  {
    id: "chase-jobs",
    path: "/chase/jobs",
    label: "Chaser jobs",
    area: "Chase",
    defaultRoles: [...MGMT, "field_chaser", "field"],
  },
  {
    id: "chase-dispatch",
    path: "/chase/dispatch",
    label: "Dispatch",
    area: "Chase",
    defaultRoles: MGMT,
  },
  {
    id: "chase-performance",
    path: "/chase/performance",
    label: "Chase performance",
    area: "Chase",
    defaultRoles: MGMT,
  },
  {
    id: "chase-my-performance",
    path: "/chase/my-performance",
    label: "My chase performance",
    area: "Chase",
    defaultRoles: [...MGMT, "field_chaser", "field"],
  },

  // -------------------------------------------------------------- Operations
  {
    /*
     * The Jobs module itself. Sellers are deliberately absent: the sidebar has
     * never offered them this page (app-shell gives it to management and crew),
     * but the catalogue did, so typing /jobs walked straight into the full list
     * and its "New job" button while ten other management URLs refused the same
     * account. `exact` keeps that refusal off the job records below.
     */
    id: "jobs",
    path: "/jobs",
    exact: true,
    label: "Jobs",
    area: "Operations",
    defaultRoles: [...MGMT, ...FIELD],
    note: "The Jobs list. Individual job records are governed by 'Job record'.",
  },
  {
    /*
     * One job, and the new-job form. A seller reaches these legitimately — from
     * a payout on My commissions, or a card on their own dashboard — so this
     * stays as generous as /jobs used to be. It is not seeded into the
     * `permissions` catalogue, which means it answers from these defaults.
     */
    id: "job-detail",
    path: "/jobs",
    label: "Job record",
    area: "Operations",
    defaultRoles: [...MGMT, ...FIELD, ...SELLERS],
    note: "A single job under /jobs/…, reached from a payout, dashboard or pipeline card.",
  },
  {
    id: "intake-inbox",
    path: "/intake-inbox",
    label: "Intake forms",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "estimates",
    path: "/estimates",
    label: "Job Calculator",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "projects",
    path: "/projects",
    label: "Pictures",
    area: "Operations",
    defaultRoles: [...MGMT, "crew", "field", "field_chaser"],
  },
  {
    id: "equipment",
    path: "/equipment",
    label: "Equipment",
    area: "Operations",
    defaultRoles: [...MGMT, "crew", "field"],
  },
  {
    id: "supplies",
    path: "/supplies",
    label: "Supplies",
    area: "Operations",
    defaultRoles: [...MGMT, "crew", "field", "field_chaser", "sales_rep"],
  },
  {
    id: "receipts",
    path: "/receipts",
    label: "Receipts",
    area: "Operations",
    // Everybody who can buy something for the company uploads here; the
    // approve tab inside is the database's decision, not this list's.
    defaultRoles: [...MGMT, "sales_rep", ...FIELD],
  },
  {
    id: "field-camera",
    path: "/camera",
    label: "Field camera",
    area: "Operations",
    // Whoever photographs jobs today from the Pictures tab. The job picker
    // inside offers only jobs the person can add photos to.
    defaultRoles: [...MGMT, "sales_rep", ...FIELD],
    note: "Full-screen job camera with a time, date and address stamp on every photo.",
  },
  {
    id: "timeclock",
    path: "/timeclock",
    label: "Time clock",
    area: "Operations",
    defaultRoles: [...MGMT, "sales_rep", ...FIELD],
  },
  {
    id: "timesheets",
    path: "/timeclock/timesheets",
    label: "Timesheets",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "fleet",
    path: "/fleet",
    label: "Fleet",
    area: "Operations",
    defaultRoles: ["owner", "admin", "dev", "regional", "location_manager"],
    note: "Also gated by the fleet.view capability.",
  },
  {
    id: "vendors",
    path: "/vendors",
    label: "Vendors",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "documents",
    path: "/documents",
    label: "Documents",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "billing",
    path: "/billing",
    label: "Billing",
    area: "Operations",
    defaultRoles: MGMT,
  },
  {
    id: "contract",
    path: "/contract",
    label: "Contract signing",
    area: "Operations",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser", "field"],
  },

  // ----------------------------------------------------------------- Insight
  {
    id: "director",
    path: "/director",
    label: "Director dashboard",
    area: "Insight",
    defaultRoles: MGMT,
    note: "Also gated by the director.view capability.",
  },
  {
    id: "intelligence",
    path: "/intelligence",
    label: "Intelligence",
    area: "Insight",
    defaultRoles: [...MGMT, "sales_rep", "field_chaser"],
  },
  {
    id: "goals",
    path: "/goals",
    label: "Goals",
    area: "Insight",
    defaultRoles: [...MGMT, "sales_rep", "field_chaser"],
  },
  {
    id: "my-goals",
    path: "/my-goals",
    label: "My goals",
    area: "Insight",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser"],
  },
  {
    id: "coaching",
    path: "/coaching",
    label: "Coaching and nudges",
    area: "Insight",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser"],
  },
  {
    id: "stalled",
    path: "/stalled",
    label: "Stalled",
    area: "Insight",
    defaultRoles: MGMT,
  },
  {
    id: "compliance",
    path: "/compliance",
    label: "Compliance",
    area: "Insight",
    defaultRoles: [...MGMT, "sales_person", "sales_rep", "outside_sales_rep"],
  },
  {
    id: "profitability",
    path: "/profitability",
    label: "Profitability",
    area: "Insight",
    defaultRoles: ["owner", "admin", "dev", "sales_head"],
  },
  {
    id: "rep-cost",
    path: "/rep-cost",
    label: "Rep's cost",
    area: "Insight",
    defaultRoles: ["owner", "admin", "dev", "sales_head"],
    note: "Also gated by the rep_cost.view capability.",
  },
  {
    id: "my-commissions",
    path: "/my-commissions",
    label: "My commissions",
    area: "Insight",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser"],
  },
  {
    id: "reports",
    path: "/reports",
    label: "Reports",
    area: "Insight",
    defaultRoles: MGMT,
  },
  {
    id: "reports-weekly-sales",
    path: "/reports/weekly-sales",
    label: "Weekly sales report",
    area: "Insight",
    defaultRoles: [...MGMT, ...SELLERS],
  },
  {
    id: "assistant",
    path: "/assistant",
    label: "AI tools",
    area: "Insight",
    defaultRoles: [...MGMT, "sales_rep"],
    note: "Also gated by the ai.assistant capability.",
  },

  // -------------------------------------------------------------------- Team
  {
    id: "calendar",
    path: "/calendar",
    label: "Calendar",
    area: "Team",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS, ...FIELD],
  },
  {
    id: "calls",
    path: "/calls",
    label: "Calls",
    area: "Team",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser"],
  },
  {
    id: "tasks",
    path: "/tasks",
    label: "Tasks",
    area: "Team",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS, ...FIELD],
  },
  {
    // A personal list, so everyone with a login: there is nothing on it but
    // what its owner put there. Mark: "a to do list ... which would be user
    // specific".
    id: "todo",
    path: "/todo",
    label: "My to-do",
    area: "Team",
    defaultRoles: EVERYONE,
  },
  {
    id: "mail",
    path: "/mail",
    label: "Mail",
    area: "Team",
    defaultRoles: [...MGMT, ...SELLERS],
  },
  {
    id: "chat",
    path: "/chat",
    label: "Chat",
    area: "Team",
    defaultRoles: [...MGMT, ...RELATIONSHIP_SELLERS, ...FIELD],
  },
  {
    id: "directory",
    path: "/directory",
    label: "Staff directory",
    area: "Team",
    defaultRoles: EVERYONE,
  },
  {
    id: "expenses",
    path: "/expenses",
    label: "Expenses",
    area: "Team",
    defaultRoles: [...MGMT, ...SELLERS, "field_chaser", "field"],
  },
  {
    id: "expense-approvals",
    path: "/expenses/approvals",
    label: "Spend approvals",
    area: "Team",
    defaultRoles: ["owner", "admin", "dev", "sales_head"],
  },

  // ------------------------------------------------------------------- Admin
  {
    id: "admin",
    path: "/admin",
    label: "Settings (all admin screens)",
    area: "Admin",
    defaultRoles: PRIVILEGED,
    note: "Covers every /admin screen that is not listed separately below.",
  },
  {
    id: "admin-users",
    path: "/admin/users",
    label: "Users",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-access",
    path: "/admin/permissions",
    label: "Access (this screen)",
    area: "Admin",
    defaultRoles: PRIVILEGED,
    note:
      "The screen that edits access. Switching it off for everyone who holds it leaves only the " +
      "Developer role able to put it back — see supabase/ACCESS_RECOVERY.md.",
  },
  {
    id: "admin-field-permissions",
    path: "/admin/field-permissions",
    label: "Job field visibility",
    area: "Admin",
    defaultRoles: [...PRIVILEGED, "sales_head", "sales_manager"],
  },
  {
    // Mark, 16 Sep 2026: "this needs to have an admin menu to change and
    // add". The Sales Head owns the scorecard weights, so the page is theirs
    // as well as the owners' and admins'; the table's write policy
    // (20260916140000) admits the same three.
    id: "admin-scorecard",
    path: "/admin/scorecard",
    label: "Scorecard and points",
    area: "Admin",
    defaultRoles: [...PRIVILEGED, "sales_head"],
  },
  {
    id: "admin-security",
    path: "/admin/security",
    label: "Security settings",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-locations",
    path: "/admin/locations",
    label: "Locations and regions",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    // Melly, 6 Nov: one People area replaces the three pages below; their
    // addresses redirect here. Their entries stay so stored access rows
    // keep their meaning.
    id: "admin-people",
    path: "/admin/people",
    label: "People",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-payroll",
    path: "/admin/payroll",
    label: "People and pay",
    area: "Admin",
    defaultRoles: PRIVILEGED,
    note: "Retired: redirects to People.",
  },
  {
    id: "admin-offboarding",
    path: "/admin/offboarding",
    label: "Offboarding",
    area: "Admin",
    defaultRoles: PRIVILEGED,
    note: "Retired: redirects to People.",
  },
  {
    id: "admin-automations",
    path: "/admin/automations",
    label: "Automations",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-escalations",
    path: "/admin/escalations",
    label: "Escalation rules",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-integrations",
    path: "/admin/integrations",
    label: "Integrations",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "admin-ai-credits",
    path: "/admin/ai-credits",
    label: "AI credits",
    area: "Admin",
    defaultRoles: PRIVILEGED,
  },
  {
    id: "reassign",
    path: "/reassign",
    label: "Reassign a book",
    area: "Admin",
    defaultRoles: PRIVILEGED,
    note: "Retired: redirects to People, where it is each person's Book tab.",
  },
];

export const PAGE_BY_ID: ReadonlyMap<string, PageDef> = new Map(PAGES.map((p) => [p.id, p]));

/** Every page permission key, for seeding and for filtering catalogue rows. */
export const PAGE_PERMISSION_KEYS: readonly string[] = PAGES.map((p) => pagePermissionKey(p.id));

/**
 * Longest-prefix match. `/jobs/abc` resolves to `/jobs`; `/chase/search`
 * resolves to itself rather than `/chase`. Anything unrecognised returns null,
 * and an unrecognised path is never blocked — a page nobody registered is a
 * gap in this file, not a decision to deny.
 */
export function pageForPath(pathname: string): PageDef | null {
  const clean = normalisePath(pathname);
  let best: PageDef | null = null;
  for (const page of PAGES) {
    const p = normalisePath(page.path);
    if (p === "/") {
      if (clean === "/" && (!best || best.path === "/")) best = page;
      continue;
    }
    // An exact page owns its address and nothing under it, so when it matches
    // it is the answer — including against a subtree entry registered at the
    // same path for everything below.
    if (page.exact) {
      if (clean === p) return page;
      continue;
    }
    if (clean === p || clean.startsWith(p + "/")) {
      if (!best || p.length > normalisePath(best.path).length) best = page;
    }
  }
  return best;
}

function normalisePath(p: string): string {
  const noQuery = p.split("?")[0].split("#")[0];
  if (noQuery.length > 1 && noQuery.endsWith("/")) return noQuery.slice(0, -1);
  return noQuery || "/";
}

/** Why a person can (or cannot) reach a page. Drives the badges on screen. */
export type PageAccessSource =
  | "granted" // personal grant on this user
  | "revoked" // personal revoke on this user
  | "role" // a role they hold has it
  | "role-default" // nothing stored for this page; built-in default said yes
  | "default-denied" // nothing stored; built-in default said no
  | "denied" // stored, and no role or grant carries it
  | "fallback" // the access answer could not be fetched; essential/privileged fallback
  | "recovered" // whole page layer looked empty; fell back to built-in defaults
  | "break-glass"; // holds the recovery role, which reaches everything from code

export type PageAccess = {
  pageId: string;
  allowed: boolean;
  source: PageAccessSource;
  /** Which role carried it, when the source is a role. */
  viaRole: AppRole | null;
};

/** A page's stored state, as `effective_permissions()` reported it. */
export type StoredPageState = {
  allowed: boolean;
  /** "role" | "granted" | "revoked" | "none" — the RPC's own vocabulary. */
  source: string;
  sourceRole: AppRole | null;
};

/**
 * Build the stored-state lookup from `effective_permissions()` rows. Rows for
 * capability keys are ignored; only `page.*` keys land here. A page absent from
 * this map has nothing stored — see rule 4.
 */
export function storedPageStates(
  rows: readonly EffectivePermission[],
): Map<string, StoredPageState> {
  const out = new Map<string, StoredPageState>();
  for (const r of rows) {
    if (!isPagePermissionKey(r.permission_key)) continue;
    out.set(r.permission_key.slice(PAGE_KEY_PREFIX.length), {
      allowed: r.allowed,
      source: r.source,
      sourceRole: r.source_role,
    });
  }
  return out;
}

/**
 * The one decision function. Everything on screen and the route gate itself go
 * through this, so there is a single place a subtle bug could live and a single
 * place the tests point at.
 *
 * Order — one exception, then two rules:
 *   0. The break-glass role. `dev` reaches every page, decided here and not
 *      read from anywhere, so no edit on the Access screen and no personal
 *      revoke can take it away. This is the short-circuit that used to apply to
 *      Owner, Admin and Developer alike; it is back for this one role only,
 *      because with everything else switchable something has to guarantee a way
 *      back into the Access screen.
 *   1. Stored state, if this page has any. The same precedence the database
 *      applies: personal revoke > personal grant > role. This decides for EVERY
 *      role, Owner, Admin and Developer included: they are rows in
 *      `role_permissions` like everyone else, so the Access screen can switch
 *      them off, which is what Mark asked for. There is no short-circuit above
 *      this — switching a page off for a role switches it off.
 *   2. Nothing stored for this page: the generous built-in default. A page can
 *      have no stored row for two reasons — the seed migration has not been
 *      applied, or the page was added in code after the last seed ran. Neither
 *      is a decision to deny, so the default says yes to
 *        (a) the page's own `defaultRoles`, which reproduce today's sidebar and
 *            which every page must list Owner/Admin/Dev in (enforced by test);
 *        (b) Owner, Admin and Developer regardless, so a page added next month
 *            can never lock administrators out before someone remembers to tick
 *            it; and
 *        (c) everyone, for the three essential pages, so an unseeded database
 *            never yields a blank app.
 *      All three are DEFAULTS. The moment a row exists for the page, rule 1
 *      decides and the default is not consulted — including for a privileged
 *      role and including for an essential page.
 */
export function resolvePageAccess(input: {
  page: PageDef;
  roles: readonly AppRole[];
  stored: ReadonlyMap<string, StoredPageState>;
}): PageAccess {
  const { page, roles, stored } = input;

  if (isBreakGlass(roles)) {
    return {
      pageId: page.id,
      allowed: true,
      source: "break-glass",
      viaRole: BREAK_GLASS_ROLE,
    };
  }

  const state = stored.get(page.id);
  if (state) {
    if (state.source === "granted") {
      return { pageId: page.id, allowed: true, source: "granted", viaRole: null };
    }
    if (state.source === "revoked") {
      return { pageId: page.id, allowed: false, source: "revoked", viaRole: null };
    }
    if (state.source === "role" && state.allowed) {
      return {
        pageId: page.id,
        allowed: true,
        source: "role",
        viaRole: state.sourceRole ?? null,
      };
    }
    return { pageId: page.id, allowed: false, source: "denied", viaRole: null };
  }

  const viaRole = defaultRoleFor(page, roles);
  if (viaRole) return { pageId: page.id, allowed: true, source: "role-default", viaRole };
  if (page.essential || isPrivileged(roles as AppRole[])) {
    return { pageId: page.id, allowed: true, source: "role-default", viaRole: null };
  }
  return { pageId: page.id, allowed: false, source: "default-denied", viaRole: null };
}

/**
 * The generous default, as a predicate, so the role view and the tests agree
 * with the resolver instead of restating it.
 *
 * Only consulted when there is nothing stored for the page.
 */
export function defaultAllows(page: PageDef, role: AppRole): boolean {
  return !!page.essential || page.defaultRoles.includes(role) || isPrivileged([role]);
}

/** Which of these roles carries the page by built-in default, if any. */
function defaultRoleFor(page: PageDef, roles: readonly AppRole[]): AppRole | null {
  return roles.find((r) => defaultAllows(page, r)) ?? null;
}

export type PageAccessMap = {
  /** Decision per page id. */
  byPage: ReadonlyMap<string, PageAccess>;
  /**
   * Retained for existing callers. Explicit denials are never recovered.
   */
  recovered: boolean;
  /** True when nothing is stored for any page (migration not applied yet). */
  unconfigured: boolean;
};

/**
 * Resolve every page without replacing stored denials with role defaults.
 *
 * `unavailable` is the one place anything still overrides a stored answer, and
 * it is not a lock on the Access screen: it means the permission read FAILED,
 * so there is no stored answer to honour. Rather than hand someone a blank app
 * on a dropped request, the essential pages and the privileged roles keep
 * working until the read succeeds — at which point the stored rows decide, and
 * a privileged role that has genuinely been switched off a page is refused it.
 */
export function resolveAllPages(input: {
  roles: readonly AppRole[];
  stored: ReadonlyMap<string, StoredPageState>;
  unavailable?: boolean;
}): PageAccessMap {
  const { roles, stored, unavailable = false } = input;
  const unconfigured = !unavailable && stored.size === 0;

  const first = new Map<string, PageAccess>();
  for (const page of PAGES) {
    if (!unavailable) {
      first.set(page.id, resolvePageAccess({ page, roles, stored }));
      continue;
    }
    const keep = isBreakGlass(roles) || !!page.essential || isPrivileged(roles as AppRole[]);
    first.set(
      page.id,
      keep
        ? { pageId: page.id, allowed: true, source: "fallback", viaRole: null }
        : { pageId: page.id, allowed: false, source: "denied", viaRole: null },
    );
  }

  return { byPage: first, recovered: false, unconfigured };
}

/**
 * Role-only view, for the management screen's "what can this role reach"
 * column. Ignores personal overrides by construction: it is asked about a role,
 * not a person.
 *
 * Every role is answered from its rows in `role_permissions` — Owner and Admin
 * included, so the screen shows and edits what is really stored. The one
 * exception is the break-glass role, which is answered from code exactly as a
 * person holding it is: every page, always, whatever the rows say. Drawing it
 * from its rows would show a picture the app does not honour, and would invite
 * an administrator to "fix" a row that changes nothing.
 *
 * `knownPages` is the set of page ids that actually exist in the `permissions`
 * catalogue: a page in this file but not in the catalogue has nothing to store,
 * so it falls back to the generous built-in default rather than reading as
 * "denied" and inviting an admin to fix a page that is not broken.
 */
export function resolveRolePages(input: {
  role: AppRole;
  /** role -> set of page ids stored in role_permissions. */
  storedRolePages: ReadonlyMap<AppRole, ReadonlySet<string>>;
  /** True once the catalogue rows exist in `permissions`. */
  catalogueSeeded: boolean;
  /** Page ids present in the catalogue. Omit to treat every page as present. */
  knownPages?: ReadonlySet<string>;
}): Map<string, PageAccess> {
  const { role, storedRolePages, catalogueSeeded, knownPages } = input;
  const stored = storedRolePages.get(role);
  const out = new Map<string, PageAccess>();

  if (role === BREAK_GLASS_ROLE) {
    for (const page of PAGES) {
      out.set(page.id, {
        pageId: page.id,
        allowed: true,
        source: "break-glass",
        viaRole: BREAK_GLASS_ROLE,
      });
    }
    return out;
  }

  for (const page of PAGES) {
    const inCatalogue = catalogueSeeded && (knownPages ? knownPages.has(page.id) : true);
    if (!inCatalogue) {
      const allowed = defaultAllows(page, role);
      out.set(page.id, {
        pageId: page.id,
        allowed,
        source: allowed ? "role-default" : "default-denied",
        viaRole: allowed ? role : null,
      });
      continue;
    }
    const allowed = stored?.has(page.id) ?? false;
    out.set(page.id, {
      pageId: page.id,
      allowed,
      source: allowed ? "role" : "denied",
      viaRole: allowed ? role : null,
    });
  }
  return out;
}

// -------------------------------------------------------------- lockout guard

/**
 * The page that edits access. Switching it off everywhere leaves the
 * break-glass role as the only way back in.
 */
export const ACCESS_PAGE_ID = "admin-access";

/** One person, as the lockout check needs to see them. */
export type AccessCandidate = {
  userId: string;
  isActive: boolean;
  roles: readonly AppRole[];
};

/**
 * Which roles carry `page.admin-access` once a pending change is applied.
 *
 * `change` describes the edit that has not been saved yet, so the caller can
 * ask "if I save this, what is left?" before saving it.
 */
export function rolesHoldingAccessPageAfter(input: {
  storedRolePages: ReadonlyMap<AppRole, ReadonlySet<string>>;
  catalogueSeeded: boolean;
  knownPages?: ReadonlySet<string>;
  change?: { role: AppRole; pageIds: readonly string[]; on: boolean };
}): Set<AppRole> {
  const { storedRolePages, catalogueSeeded, knownPages, change } = input;
  const out = new Set<AppRole>();
  for (const role of ALL_ROLES) {
    // The break-glass role holds it unconditionally, and no pending change can
    // take it away — the screen will not offer the edit and the database
    // refuses the write.
    if (role === BREAK_GLASS_ROLE) {
      out.add(role);
      continue;
    }
    const resolved = resolveRolePages({ role, storedRolePages, catalogueSeeded, knownPages });
    let has = resolved.get(ACCESS_PAGE_ID)?.allowed ?? false;
    if (change && change.role === role && change.pageIds.includes(ACCESS_PAGE_ID)) {
      has = change.on;
    }
    if (has) out.add(role);
  }
  return out;
}

/**
 * Who could still open AND edit Settings → Access.
 *
 * Anyone active holding the break-glass role is a keeper outright: no stored
 * row and no personal revoke can take the Access page off them, so there is no
 * further condition to check. That is the point of the role — while somebody
 * holds it, the Access screen cannot be orphaned.
 *
 * For everyone else all three have to be true, because all three are enforced
 * somewhere:
 *   - the person is active (an offboarded account cannot sign in);
 *   - they hold Owner, Admin or Developer — admin.permissions.tsx shows every
 *     other role the job-fields panel only, so reaching the page is not enough;
 *   - `page.admin-access` resolves allowed for them, by role or by a personal
 *     grant, and is not personally revoked.
 *
 * Returns the user ids, not a count, so the confirm step can name them.
 */
export function accessPageKeepers(input: {
  people: readonly AccessCandidate[];
  rolesWithAccessPage: ReadonlySet<AppRole>;
  /** user id -> personal override on `page.admin-access`. */
  personalOverrides?: ReadonlyMap<string, "grant" | "revoke">;
}): string[] {
  const { people, rolesWithAccessPage, personalOverrides } = input;
  const out: string[] = [];
  for (const p of people) {
    if (!p.isActive) continue;
    if (isBreakGlass(p.roles)) {
      out.push(p.userId);
      continue;
    }
    if (!isPrivileged(p.roles as AppRole[])) continue;
    const override = personalOverrides?.get(p.userId);
    if (override === "revoke") continue;
    const byRole = p.roles.some((r) => rolesWithAccessPage.has(r as AppRole));
    if (byRole || override === "grant") out.push(p.userId);
  }
  return out;
}

/**
 * The predicate the confirm step asks: would saving this change leave nobody at
 * all able to reach the Access screen?
 *
 * It never blocks the change — Mark asked for no locks — it only makes the
 * consequence impossible to walk into unknowingly.
 *
 * Since `dev` became the break-glass role this is no longer the unrecoverable
 * edit it was: while one active person holds `dev`, the answer here is always
 * false, because that person is a keeper. It fires only when nobody holds the
 * recovery role either, and the confirm says so.
 */
export function wouldOrphanAccessPage(input: {
  people: readonly AccessCandidate[];
  storedRolePages: ReadonlyMap<AppRole, ReadonlySet<string>>;
  catalogueSeeded: boolean;
  knownPages?: ReadonlySet<string>;
  personalOverrides?: ReadonlyMap<string, "grant" | "revoke">;
  change: { role: AppRole; pageIds: readonly string[]; on: boolean };
}): boolean {
  if (!input.change.pageIds.includes(ACCESS_PAGE_ID) || input.change.on) return false;
  const rolesWithAccessPage = rolesHoldingAccessPageAfter(input);
  return (
    accessPageKeepers({
      people: input.people,
      rolesWithAccessPage,
      personalOverrides: input.personalOverrides,
    }).length === 0
  );
}

export const PAGE_SOURCE_LABEL: Record<PageAccessSource, string> = {
  granted: "Granted to this person",
  revoked: "Revoked for this person",
  role: "From role",
  "role-default": "From role (default)",
  "default-denied": "Not in role default",
  denied: "Not granted",
  fallback: "Default (access could not be checked)",
  recovered: "Default (no rules stored)",
  "break-glass": "Recovery role — always on",
};
