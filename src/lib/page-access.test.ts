import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { AppRole } from "@/lib/roles";
import type { EffectivePermission } from "@/lib/permissions";
import {
  ACCESS_PAGE_ID,
  BREAK_GLASS_ROLE,
  PAGES,
  PAGE_PERMISSION_KEYS,
  accessPageKeepers,
  isBreakGlass,
  defaultAllows,
  pageForPath,
  pagePermissionKey,
  resolveAllPages,
  resolvePageAccess,
  resolveRolePages,
  rolesHoldingAccessPageAfter,
  storedPageStates,
  wouldOrphanAccessPage,
  type AccessCandidate,
  type PageDef,
  type StoredPageState,
} from "@/lib/page-access";

const page = (id: string): PageDef => {
  const p = PAGES.find((x) => x.id === id);
  if (!p) throw new Error(`no page ${id}`);
  return p;
};

const stored = (entries: Record<string, StoredPageState>): Map<string, StoredPageState> =>
  new Map(Object.entries(entries));

const fromRole = (role: AppRole): StoredPageState => ({
  allowed: true,
  source: "role",
  sourceRole: role,
});
const granted: StoredPageState = { allowed: true, source: "granted", sourceRole: null };
const revoked: StoredPageState = { allowed: false, source: "revoked", sourceRole: null };
const none: StoredPageState = { allowed: false, source: "none", sourceRole: null };

/** Every page id in the catalogue, marked as carried by the given role. */
const everyPageFor = (role: AppRole): Map<string, StoredPageState> =>
  new Map(PAGES.map((p) => [p.id, fromRole(role)]));

/** Every page id in the catalogue, marked as not granted. */
const noPages = (): Map<string, StoredPageState> => new Map(PAGES.map((p) => [p.id, none]));

describe("page catalog", () => {
  it("has unique ids, and no two entries decide the same URL", () => {
    expect(new Set(PAGES.map((p) => p.id)).size).toBe(PAGES.length);
    /*
     * Paths used to be unique outright. `exact` splits one address from the
     * subtree under it — /jobs is management's module while /jobs/<id> is a
     * record a seller opens from their own commission — so two entries may
     * share a path as long as one is exact and the other is not. What must
     * stay unique is the URL space each entry claims, which is the pair.
     */
    const claim = (p: (typeof PAGES)[number]) => `${p.path}|${p.exact ? "exact" : "subtree"}`;
    expect(new Set(PAGES.map(claim)).size).toBe(PAGES.length);
  });

  it("namespaces every key so pages and capabilities cannot collide", () => {
    for (const key of PAGE_PERMISSION_KEYS) expect(key.startsWith("page.")).toBe(true);
    expect(new Set(PAGE_PERMISSION_KEYS).size).toBe(PAGES.length);
  });

  it("keeps every page inside a known area with at least one default role", () => {
    for (const p of PAGES) {
      expect(p.area.length).toBeGreaterThan(0);
      expect(p.defaultRoles.length).toBeGreaterThan(0);
      expect(p.path.startsWith("/")).toBe(true);
    }
  });

  it("gives owner, admin and dev a default on every page", () => {
    for (const p of PAGES) {
      for (const r of ["owner", "admin", "dev"] as AppRole[]) {
        expect(p.defaultRoles.includes(r), `${p.id} is missing ${r} from defaultRoles`).toBe(true);
      }
    }
  });

  it("gives relationship sellers the pages needed to manage Melly's workflow", () => {
    const workflowPages = [
      "pipeline",
      "active-clients",
      "routes",
      "tradeshows",
      "calendar",
      "tasks",
      "chat",
    ];
    for (const id of workflowPages) {
      for (const role of ["sales_person", "sales_rep", "outside_sales_rep"] as AppRole[]) {
        expect(page(id).defaultRoles, `${role} is missing ${id}`).toContain(role);
      }
    }
  });
});

describe("pageForPath", () => {
  it("matches an exact path", () => {
    expect(pageForPath("/pipeline")?.id).toBe("pipeline");
  });

  it("matches a detail route to its parent page", () => {
    expect(pageForPath("/accounts/abc/notes")?.id).toBe("accounts");
    expect(pageForPath("/farming/campaigns")?.id).toBe("active-clients");
  });

  it("separates the Jobs module from a single job record", () => {
    // The module is management's; the record is reachable by a seller from a
    // payout on My commissions or a card on their own dashboard.
    expect(pageForPath("/jobs")?.id).toBe("jobs");
    expect(pageForPath("/jobs/")?.id).toBe("jobs");
    expect(pageForPath("/jobs?tab=mine")?.id).toBe("jobs");
    expect(pageForPath("/jobs/8f2a-1234")?.id).toBe("job-detail");
    expect(pageForPath("/jobs/new")?.id).toBe("job-detail");
  });

  it("prefers the longest match, not the first", () => {
    expect(pageForPath("/chase")?.id).toBe("chase-cockpit");
    expect(pageForPath("/chase/search")?.id).toBe("chase-search");
    expect(pageForPath("/chase/my-performance")?.id).toBe("chase-my-performance");
    expect(pageForPath("/reports")?.id).toBe("reports");
    expect(pageForPath("/reports/weekly-sales")?.id).toBe("reports-weekly-sales");
    expect(pageForPath("/timeclock/timesheets")?.id).toBe("timesheets");
    expect(pageForPath("/expenses/approvals")?.id).toBe("expense-approvals");
    expect(pageForPath("/admin/users/42")?.id).toBe("admin-users");
    expect(pageForPath("/admin/tags")?.id).toBe("admin");
  });

  it("does not let a path prefix bleed across a word boundary", () => {
    // "/routes" must not swallow "/routes-elsewhere" style siblings.
    expect(pageForPath("/route-planner")).toBeNull();
    expect(pageForPath("/chaser")).toBeNull();
  });

  it("normalizes trailing slashes, query strings and hashes", () => {
    expect(pageForPath("/pipeline/")?.id).toBe("pipeline");
    expect(pageForPath("/pipeline?stage=new")?.id).toBe("pipeline");
    expect(pageForPath("/pipeline#top")?.id).toBe("pipeline");
    expect(pageForPath("/")?.id).toBe("dashboard");
  });

  it("returns null for an unregistered path rather than guessing", () => {
    expect(pageForPath("/something-new")).toBeNull();
  });
});

describe("resolvePageAccess — precedence", () => {
  const roles: AppRole[] = ["sales_rep"];

  it("1. a stored row decides for essential pages too — nothing is locked on", () => {
    // Mark: "on the access page everything needs to be togglable, nothing
    // should be locked." Dashboard, notifications and /security included.
    for (const p of PAGES.filter((x) => x.essential)) {
      const r = resolvePageAccess({
        page: p,
        roles: ["crew"],
        stored: stored({ [p.id]: revoked }),
      });
      expect(r.allowed, `${p.id} must follow the stored row`).toBe(false);
      expect(r.source).toBe("revoked");

      const cleared = resolvePageAccess({
        page: p,
        roles: ["crew"],
        stored: stored({ [p.id]: none }),
      });
      expect(cleared.allowed, `${p.id} must follow a cleared role row`).toBe(false);
      expect(cleared.source).toBe("denied");
    }
  });

  it("2. a stored row decides for owner and admin — the short-circuit is gone", () => {
    // This is the reversal. It used to be "privileged reaches everything";
    // a privileged role with no row for a page is now simply denied it.
    // `dev` is the exception and has its own describe block below.
    for (const role of ["owner", "admin"] as AppRole[]) {
      for (const p of PAGES.filter((x) => !x.essential)) {
        const r = resolvePageAccess({ page: p, roles: [role], stored: noPages() });
        expect(r.allowed, `${role} must be denied ${p.id} with no row`).toBe(false);
        expect(r.source).toBe("denied");
      }
    }
  });

  it("2b. an admin can be blocked from one page and keep the rest", () => {
    const s = new Map(everyPageFor("admin"));
    s.set("pipeline", revoked);
    expect(
      resolvePageAccess({ page: page("pipeline"), roles: ["admin"], stored: s }),
    ).toMatchObject({ allowed: false, source: "revoked" });
    expect(resolvePageAccess({ page: page("jobs"), roles: ["admin"], stored: s }).allowed).toBe(
      true,
    );
  });

  it("2c. a personal revoke now beats a privileged role", () => {
    const r = resolvePageAccess({
      page: page("pipeline"),
      roles: ["admin", "crew"],
      stored: stored({ pipeline: revoked }),
    });
    expect(r.allowed).toBe(false);
    expect(r.source).toBe("revoked");
  });

  it("3. a personal revoke beats a role grant", () => {
    const r = resolvePageAccess({
      page: page("pipeline"),
      roles,
      stored: stored({ pipeline: revoked }),
    });
    expect(r.allowed).toBe(false);
    expect(r.source).toBe("revoked");
  });

  it("3b. a personal grant beats an absent role grant", () => {
    const r = resolvePageAccess({
      page: page("fleet"),
      roles: ["crew"],
      stored: stored({ fleet: granted }),
    });
    expect(r.allowed).toBe(true);
    expect(r.source).toBe("granted");
  });

  it("3c. a role grant is reported with the role that carried it", () => {
    const r = resolvePageAccess({
      page: page("pipeline"),
      roles: ["sales_rep", "crew"],
      stored: stored({ pipeline: fromRole("sales_rep") }),
    });
    expect(r).toMatchObject({ allowed: true, source: "role", viaRole: "sales_rep" });
  });

  it("3d. stored-and-not-granted is a refusal, not a fall-through to defaults", () => {
    // /pipeline IS in sales_rep's built-in default list. Once an admin has
    // explicitly cleared it, the default must not quietly hand it back.
    expect(page("pipeline").defaultRoles).toContain("sales_rep");
    const r = resolvePageAccess({
      page: page("pipeline"),
      roles,
      stored: stored({ pipeline: none, jobs: fromRole("sales_rep") }),
    });
    expect(r.allowed).toBe(false);
    expect(r.source).toBe("denied");
  });

  it("4. nothing stored falls back to the built-in default", () => {
    const yes = resolvePageAccess({ page: page("pipeline"), roles, stored: new Map() });
    expect(yes).toMatchObject({ allowed: true, source: "role-default", viaRole: "sales_rep" });

    const no = resolvePageAccess({ page: page("fleet"), roles, stored: new Map() });
    expect(no).toMatchObject({ allowed: false, source: "default-denied" });
  });

  it("4b. a partially seeded catalog mixes stored answers with defaults", () => {
    // Only /jobs was seeded. /pipeline has no row, so it keeps its default.
    const partial = stored({ jobs: none });
    expect(resolvePageAccess({ page: page("jobs"), roles, stored: partial }).allowed).toBe(false);
    expect(resolvePageAccess({ page: page("pipeline"), roles, stored: partial }).allowed).toBe(
      true,
    );
  });

  it("holding several roles takes the union, never the intersection", () => {
    const r = resolvePageAccess({
      page: page("fleet"),
      roles: ["crew", "location_manager"],
      stored: new Map(),
    });
    expect(r.allowed).toBe(true);
  });
});

/**
 * The break-glass role.
 *
 * With Owner and Admin switchable, the Access screen can be switched off for
 * everybody. `dev` is the one role that cannot be, so there is always a way
 * back. These are the cases that would make it not a break-glass: a stored
 * denial, a personal revoke, a page the catalogue has never heard of, and the
 * confirm step forgetting that the holder exists.
 */
describe("dev — the break-glass role", () => {
  const OTHER_PRIVILEGED: AppRole[] = ["owner", "admin"];

  it("is `dev`, and isBreakGlass recognizes it among other roles", () => {
    expect(BREAK_GLASS_ROLE).toBe("dev");
    expect(isBreakGlass(["dev"])).toBe(true);
    expect(isBreakGlass(["crew", "dev"])).toBe(true);
    expect(isBreakGlass(["owner", "admin"])).toBe(false);
    expect(isBreakGlass([])).toBe(false);
  });

  it("reaches a page whose role row has been cleared", () => {
    for (const p of PAGES) {
      const r = resolvePageAccess({ page: p, roles: ["dev"], stored: noPages() });
      expect(r.allowed, `dev must still reach ${p.id}`).toBe(true);
      expect(r.source).toBe("break-glass");
      expect(r.viaRole).toBe("dev");
    }
  });

  it("reaches a page carrying an explicit personal revoke", () => {
    const r = resolvePageAccess({
      page: page(ACCESS_PAGE_ID),
      roles: ["dev"],
      stored: stored({ [ACCESS_PAGE_ID]: revoked }),
    });
    expect(r.allowed).toBe(true);
    expect(r.source).toBe("break-glass");
  });

  it("reaches every page even when every row denies and every page is revoked", () => {
    const hostile = new Map(PAGES.map((p) => [p.id, revoked] as const));
    const map = resolveAllPages({ roles: ["dev"], stored: hostile });
    for (const p of PAGES) expect(map.byPage.get(p.id)?.allowed, p.id).toBe(true);
  });

  it("reaches a page that is not in the catalog at all", () => {
    const unseeded: PageDef = {
      id: "page-invented-next-month",
      path: "/invented-next-month",
      label: "Invented next month",
      area: "Admin",
      defaultRoles: ["owner"], // deliberately omits dev
    };
    // Nothing stored...
    expect(resolvePageAccess({ page: unseeded, roles: ["dev"], stored: new Map() }).allowed).toBe(
      true,
    );
    // ...and a catalogue that knows every page except this one.
    const known = new Set(PAGES.map((p) => p.id));
    const m = resolveRolePages({
      role: "dev",
      storedRolePages: new Map(),
      catalogueSeeded: true,
      knownPages: known,
    });
    for (const p of PAGES) expect(m.get(p.id)?.allowed, p.id).toBe(true);
  });

  it("keeps the role view read-only-looking: every page on, sourced break-glass", () => {
    const m = resolveRolePages({
      role: "dev",
      storedRolePages: new Map([["dev", new Set<string>()]]),
      catalogueSeeded: true,
    });
    expect([...m.values()].every((a) => a.allowed && a.source === "break-glass")).toBe(true);
  });

  it("does NOT leak to the other privileged roles — they still follow stored rows", () => {
    for (const role of OTHER_PRIVILEGED) {
      const r = resolvePageAccess({ page: page("pipeline"), roles: [role], stored: noPages() });
      expect(r.allowed, `${role} must follow the stored row`).toBe(false);
      expect(r.source).toBe("denied");

      const revokedForThem = resolvePageAccess({
        page: page("pipeline"),
        roles: [role],
        stored: stored({ pipeline: revoked }),
      });
      expect(revokedForThem.allowed).toBe(false);

      const m = resolveRolePages({
        role,
        storedRolePages: new Map([[role, new Set(["jobs"])]]),
        catalogueSeeded: true,
      });
      expect(m.get("jobs")?.allowed).toBe(true);
      expect(m.get("pipeline")?.allowed).toBe(false);
    }
  });

  it("does not widen anyone who merely holds a privileged role alongside", () => {
    // owner + admin is not dev. Nothing about holding two roles conjures it.
    const r = resolvePageAccess({
      page: page("pipeline"),
      roles: ["owner", "admin"],
      stored: noPages(),
    });
    expect(r.allowed).toBe(false);
  });
});

/**
 * The half of the change that had to replace the short-circuit rather than
 * simply delete it: with stored rows deciding for everyone, a page nobody has
 * seeded yet must not be silently denied to the people who administer the app.
 */
describe("the generous default for an unseeded page", () => {
  const futurePage: PageDef = {
    id: "brand-new",
    path: "/brand-new",
    label: "Brand new",
    area: "Operations",
    defaultRoles: ["owner", "admin", "dev", "location_manager"],
  };

  it("owner and admin reach a page added after the last seed ran", () => {
    // dev reaches it too, but from the break-glass rule rather than this
    // default — see the "dev — the break-glass role" block above.
    for (const role of ["owner", "admin"] as AppRole[]) {
      const r = resolvePageAccess({ page: futurePage, roles: [role], stored: noPages() });
      expect(r.allowed, `${role} must reach an unseeded page`).toBe(true);
      expect(r.source).toBe("role-default");
    }
  });

  it("privileged roles reach it even if the author forgot to list them", () => {
    const sloppy: PageDef = { ...futurePage, id: "sloppy", defaultRoles: ["crew"] };
    for (const role of ["owner", "admin", "dev"] as AppRole[]) {
      expect(resolvePageAccess({ page: sloppy, roles: [role], stored: noPages() }).allowed).toBe(
        true,
      );
    }
  });

  it("the roles that hold the comparable existing pages reach it too", () => {
    // defaultRoles is that list: it is what the page's neighbours are set to.
    expect(
      resolvePageAccess({ page: futurePage, roles: ["location_manager"], stored: noPages() })
        .allowed,
    ).toBe(true);
  });

  it("but it is a default, not a lock: one stored row turns it off again", () => {
    // dev is the deliberate exception and is asserted the other way above.
    const seededOff = new Map([...noPages(), ["brand-new", none as StoredPageState]]);
    for (const role of ["owner", "admin"] as AppRole[]) {
      expect(
        resolvePageAccess({ page: futurePage, roles: [role], stored: seededOff }).allowed,
      ).toBe(false);
    }
  });

  it("does not hand the new page to a role that has no claim on it", () => {
    expect(
      resolvePageAccess({ page: futurePage, roles: ["crew"], stored: new Map() }).allowed,
    ).toBe(false);
  });

  it("essential pages default open for anyone, so an unseeded app is never blank", () => {
    for (const p of PAGES.filter((x) => x.essential)) {
      expect(defaultAllows(p, "some_future_role" as AppRole)).toBe(true);
      expect(resolvePageAccess({ page: p, roles: [], stored: new Map() }).allowed).toBe(true);
    }
  });
});

describe("resolveAllPages — failure modes", () => {
  it("unapplied migration: nothing stored means today's behavior, exactly", () => {
    const map = resolveAllPages({ roles: ["sales_rep"], stored: new Map() });
    expect(map.unconfigured).toBe(true);
    expect(map.recovered).toBe(false);
    for (const p of PAGES) {
      expect(map.byPage.get(p.id)?.allowed).toBe(defaultAllows(p, "sales_rep"));
    }
  });

  it("a seeded catalog with no role grants denies optional pages", () => {
    // Catalogue seeded, but this role has no role_permissions rows at all.
    const map = resolveAllPages({ roles: ["sales_rep"], stored: noPages() });
    expect(map.recovered).toBe(false);
    expect(map.byPage.get("pipeline")?.allowed).toBe(false);
    expect(map.byPage.get("pipeline")?.source).toBe("denied");
    expect(map.byPage.get("fleet")?.allowed).toBe(false);
  });

  it("recovery never fires when the role legitimately has one page", () => {
    const map = resolveAllPages({
      roles: ["crew"],
      stored: new Map([...noPages(), ["timeclock", fromRole("crew")]]),
    });
    expect(map.recovered).toBe(false);
    expect(map.byPage.get("timeclock")?.allowed).toBe(true);
    expect(map.byPage.get("jobs")?.allowed).toBe(false);
  });

  it("essential-only grants do not restore optional pages", () => {
    const onlyEssential = new Map<string, StoredPageState>(
      PAGES.map((p) => [p.id, p.essential ? granted : none]),
    );
    const map = resolveAllPages({ roles: ["crew"], stored: onlyEssential });
    expect(map.recovered).toBe(false);
    for (const p of PAGES) expect(map.byPage.get(p.id)?.allowed).toBe(!!p.essential);
  });

  it("honors personal revocations on every page, essential ones included", () => {
    const stored = new Map(PAGES.map((p) => [p.id, revoked]));
    const map = resolveAllPages({ roles: ["sales_rep"], stored });
    expect(map.recovered).toBe(false);
    for (const p of PAGES) expect(map.byPage.get(p.id)?.allowed).toBe(false);
  });

  it("permission failures deny optional pages even with cached grants", () => {
    for (const roles of [["sales_rep"], []] as AppRole[][]) {
      for (const stored of [new Map<string, StoredPageState>(), everyPageFor("sales_rep")]) {
        const map = resolveAllPages({ roles, stored, unavailable: true });
        expect(map.unconfigured).toBe(false);
        for (const p of PAGES) expect(map.byPage.get(p.id)?.allowed).toBe(!!p.essential);
      }
    }
  });

  it("trusted privileged roles retain structural page access during permission failures", () => {
    for (const role of ["owner", "admin", "dev"] as AppRole[]) {
      const map = resolveAllPages({ roles: [role], stored: noPages(), unavailable: true });
      for (const p of PAGES) expect(map.byPage.get(p.id)?.allowed).toBe(true);
    }
  });

  it("unknown role: no defaults match, so only the essential pages remain", () => {
    const unknown = ["some_future_role" as AppRole];
    const map = resolveAllPages({ roles: unknown, stored: new Map() });
    for (const p of PAGES) {
      expect(map.byPage.get(p.id)?.allowed).toBe(!!p.essential);
    }
    // Never a blank app: the dashboard is still there.
    expect(map.byPage.get("dashboard")?.allowed).toBe(true);
  });

  it("no roles at all: essential pages only, and no crash", () => {
    const map = resolveAllPages({ roles: [], stored: new Map() });
    expect(map.byPage.get("dashboard")?.allowed).toBe(true);
    expect(map.byPage.get("pipeline")?.allowed).toBe(false);
  });

  it("an admin now depends on data, and an unseeded catalog is generous to them", () => {
    // Nothing stored: the built-in default carries them, on every page.
    const fresh = resolveAllPages({ roles: ["admin"], stored: new Map() });
    for (const p of PAGES) expect(fresh.byPage.get(p.id)?.allowed).toBe(true);

    // Seeded and cleared: they are denied, because that is what was stored.
    const cleared = resolveAllPages({ roles: ["admin"], stored: noPages() });
    expect(cleared.recovered).toBe(false);
    for (const p of PAGES) expect(cleared.byPage.get(p.id)?.allowed).toBe(false);
  });
});

describe("storedPageStates", () => {
  const row = (over: Partial<EffectivePermission>): EffectivePermission => ({
    permission_key: "x",
    label: "x",
    perm_group: "g",
    allowed: false,
    source: "none",
    source_role: null,
    location_id: null,
    region_id: null,
    expires_at: null,
    granted_by: null,
    reason: null,
    override_id: null,
    ...over,
  });

  it("keeps page keys and drops capability keys", () => {
    const map = storedPageStates([
      row({ permission_key: pagePermissionKey("pipeline"), allowed: true, source: "role" }),
      row({ permission_key: "fleet.view", allowed: true, source: "role" }),
    ]);
    expect(map.size).toBe(1);
    expect(map.get("pipeline")).toMatchObject({ allowed: true, source: "role" });
  });

  it("survives an empty result without inventing state", () => {
    expect(storedPageStates([]).size).toBe(0);
  });

  it("carries the source role through", () => {
    const map = storedPageStates([
      row({
        permission_key: pagePermissionKey("jobs"),
        allowed: true,
        source: "role",
        source_role: "crew",
      }),
    ]);
    expect(map.get("jobs")?.sourceRole).toBe("crew");
  });
});

describe("resolveRolePages — the management screen's role view", () => {
  it("shows privileged roles their real stored rows, not an unconditional all", () => {
    const m = resolveRolePages({
      role: "admin",
      storedRolePages: new Map([["admin", new Set(["jobs"])]]),
      catalogueSeeded: true,
    });
    expect(m.get("jobs")?.allowed).toBe(true);
    expect(m.get("pipeline")?.allowed).toBe(false);
    expect(m.get("pipeline")?.source).toBe("denied");
    expect([...m.values()].filter((a) => a.allowed).length).toBe(1);
  });

  it("shows built-in defaults while the catalog is unseeded", () => {
    const m = resolveRolePages({
      role: "sales_rep",
      storedRolePages: new Map(),
      catalogueSeeded: false,
    });
    expect(m.get("pipeline")?.allowed).toBe(true);
    expect(m.get("pipeline")?.source).toBe("role-default");
    expect(m.get("fleet")?.allowed).toBe(false);
  });

  it("shows exactly the stored rows once the catalog is seeded", () => {
    const m = resolveRolePages({
      role: "sales_rep",
      storedRolePages: new Map([["sales_rep", new Set(["jobs"])]]),
      catalogueSeeded: true,
    });
    expect(m.get("jobs")?.allowed).toBe(true);
    expect(m.get("pipeline")?.allowed).toBe(false);
    expect(m.get("pipeline")?.source).toBe("denied");
  });

  it("essential pages are ordinary switches here too", () => {
    const m = resolveRolePages({
      role: "crew",
      storedRolePages: new Map([["crew", new Set<string>()]]),
      catalogueSeeded: true,
    });
    for (const p of PAGES.filter((x) => x.essential)) {
      expect(m.get(p.id)?.allowed, `${p.id} must follow the stored rows`).toBe(false);
    }
  });

  it("a page missing from the catalog keeps its generous default, not a denial", () => {
    const known = new Set(PAGES.map((p) => p.id).filter((id) => id !== "fleet"));
    const m = resolveRolePages({
      role: "admin",
      storedRolePages: new Map([["admin", new Set<string>()]]),
      catalogueSeeded: true,
      knownPages: known,
    });
    expect(m.get("fleet")?.allowed).toBe(true);
    expect(m.get("fleet")?.source).toBe("role-default");
    expect(m.get("jobs")?.allowed).toBe(false);
  });
});

/**
 * The lockout confirm. Removing the short-circuit makes it possible to switch
 * the Access page away from everybody, and there is no way back through the UI,
 * so the predicate that spots it before the write is the safety net.
 */
describe("lockout confirm predicate", () => {
  const seededWith = (pages: Partial<Record<AppRole, string[]>>) =>
    new Map(
      Object.entries(pages).map(([r, ids]) => [r as AppRole, new Set(ids as string[])]),
    ) as Map<AppRole, Set<string>>;

  const person = (userId: string, roles: AppRole[], isActive = true): AccessCandidate => ({
    userId,
    isActive,
    roles,
  });

  const base = {
    storedRolePages: seededWith({
      owner: [ACCESS_PAGE_ID],
      admin: [ACCESS_PAGE_ID],
      dev: [ACCESS_PAGE_ID],
    }),
    catalogueSeeded: true,
  };

  it("switching the last holding role off orphans the page", () => {
    // Only one active person, an Admin. Owner and Dev exist as roles but
    // nobody holds them, so clearing Admin leaves nobody at all.
    const people = [person("u1", ["admin"])];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });

  it("does not fire while somebody else still holds it", () => {
    const people = [person("u1", ["admin"]), person("u2", ["owner"])];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(false);
  });

  it("an inactive holder does not count as somebody", () => {
    const people = [person("u1", ["admin"]), person("u2", ["owner"], false)];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });

  it("a non-privileged holder does not count — the screen refuses them anyway", () => {
    const people = [person("u1", ["admin"]), person("u2", ["location_manager"])];
    const withManager = {
      ...base,
      storedRolePages: seededWith({
        owner: [ACCESS_PAGE_ID],
        admin: [ACCESS_PAGE_ID],
        dev: [ACCESS_PAGE_ID],
        location_manager: [ACCESS_PAGE_ID],
      }),
    };
    expect(
      wouldOrphanAccessPage({
        ...withManager,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });

  it("a personal grant keeps somebody in", () => {
    const people = [person("u1", ["admin"]), person("u2", ["owner"])];
    expect(
      wouldOrphanAccessPage({
        ...base,
        storedRolePages: seededWith({ admin: [ACCESS_PAGE_ID] }),
        people,
        personalOverrides: new Map([["u2", "grant"]]),
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(false);
  });

  it("a personal revoke takes an otherwise qualified administrator out", () => {
    const people = [person("u1", ["admin"]), person("u2", ["owner"])];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        personalOverrides: new Map([["u2", "revoke"]]),
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });

  it("clearing a whole area that contains the Access page is caught as well", () => {
    const adminArea = PAGES.filter((p) => p.area === "Admin").map((p) => p.id);
    expect(adminArea).toContain(ACCESS_PAGE_ID);
    expect(
      wouldOrphanAccessPage({
        ...base,
        people: [person("u1", ["admin"])],
        change: { role: "admin", pageIds: adminArea, on: false },
      }),
    ).toBe(true);
  });

  it("never fires for a change that does not touch the Access page", () => {
    expect(
      wouldOrphanAccessPage({
        ...base,
        people: [person("u1", ["admin"])],
        change: { role: "admin", pageIds: ["pipeline", "jobs"], on: false },
      }),
    ).toBe(false);
  });

  it("never fires for a change that switches the Access page ON", () => {
    expect(
      wouldOrphanAccessPage({
        ...base,
        storedRolePages: seededWith({}),
        people: [person("u1", ["admin"])],
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: true },
      }),
    ).toBe(false);
  });

  it("rolesHoldingAccessPageAfter applies the pending change, not the stored state", () => {
    const after = rolesHoldingAccessPageAfter({
      ...base,
      change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
    });
    expect(after.has("admin")).toBe(false);
    expect(after.has("owner")).toBe(true);
    expect(after.has("dev")).toBe(true);
  });

  it("accessPageKeepers names who is left, so the confirm can be specific", () => {
    const keepers = accessPageKeepers({
      people: [person("u1", ["admin"]), person("u2", ["owner"]), person("u3", ["crew"])],
      rolesWithAccessPage: new Set<AppRole>(["owner"]),
    });
    expect(keepers).toEqual(["u2"]);
  });

  // --- since `dev` became the break-glass role -----------------------------

  it("an active dev holder is a keeper, so the confirm does not fire at all", () => {
    const people = [person("u1", ["admin"]), person("u2", ["dev"])];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(false);
  });

  it("a dev holder keeps it even with every role row cleared and a personal revoke", () => {
    const keepers = accessPageKeepers({
      people: [person("u1", ["dev"])],
      rolesWithAccessPage: new Set<AppRole>(),
      personalOverrides: new Map([["u1", "revoke"]]),
    });
    expect(keepers).toEqual(["u1"]);
  });

  it("an INACTIVE dev holder is not a way back in", () => {
    const people = [person("u1", ["admin"]), person("u2", ["dev"], false)];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });

  it("dev always holds the page, whatever the pending change tries to do to it", () => {
    const after = rolesHoldingAccessPageAfter({
      storedRolePages: seededWith({}),
      catalogueSeeded: true,
      change: { role: "dev", pageIds: [ACCESS_PAGE_ID], on: false },
    });
    expect(after.has("dev")).toBe(true);
  });

  it("still fires when nobody holds dev — that is the case the warning is for", () => {
    const people = [person("u1", ["admin"]), person("u2", ["owner"], false)];
    expect(
      wouldOrphanAccessPage({
        ...base,
        people,
        change: { role: "admin", pageIds: [ACCESS_PAGE_ID], on: false },
      }),
    ).toBe(true);
  });
});

/**
 * Completeness. A route file with no page in the catalogue is not blocked — the
 * gate lets an unrecognised path through on purpose — but it is also not
 * configurable, so it would quietly sit outside the whole feature. This reads
 * the route directory so adding a screen without a page fails here rather than
 * on Mark's laptop.
 */
describe("every route is covered by the catalog", () => {
  const routePaths = (): string[] => {
    const dir = fileURLToPath(new URL("../routes/_authenticated", import.meta.url));
    return (
      readdirSync(dir)
        // A leading "-" is TanStack's own "not a route" marker, and those files
        // never reach the route tree, so they are not pages either.
        .filter((f) => f.endsWith(".tsx") && f !== "route.tsx" && !f.startsWith("-"))
        .filter((f) => !f.endsWith(".test.tsx"))
        .map(
          (f) =>
            "/" +
            f
              .replace(/\.tsx$/, "")
              .split(".")
              .join("/"),
        )
        .map((p) => p.replace(/\/index$/, ""))
        .map((p) => (p === "" ? "/" : p))
    );
  };

  it("maps every route file to a page", () => {
    const orphans = routePaths().filter((p) => pageForPath(p) === null);
    expect(orphans, `add these to PAGES in src/lib/page-access.ts: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });

  it("never lets an /admin route resolve to a page a non-admin role could hold by default", () => {
    for (const p of routePaths().filter((x) => x.startsWith("/admin"))) {
      const matched = pageForPath(p);
      expect(matched, `${p} has no page`).not.toBeNull();
      for (const role of ["crew", "sales_rep", "field_chaser"] as AppRole[]) {
        expect(matched!.defaultRoles.includes(role), `${p} would default open for ${role}`).toBe(
          false,
        );
      }
    }
  });

  it("resolves the mobile bottom-bar destinations for the roles that get them", () => {
    // The field bar is hardcoded per role in app-shell; these must exist as
    // pages or the bar would render links the gate then refuses.
    for (const path of ["/", "/jobs", "/timeclock", "/chat", "/chase", "/chase/jobs"]) {
      expect(pageForPath(path), `${path} has no page`).not.toBeNull();
    }
  });
});
