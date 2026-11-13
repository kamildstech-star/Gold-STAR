import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { AppRole } from "@/lib/roles";
import { PAGES, pageForPath, resolvePageAccess, type PageDef } from "@/lib/page-access";

/**
 * QA, 2026-09-16: a New York sales rep whose sidebar has no Jobs entry typed
 * /jobs and got the whole module — ten rows, filters, and a "New job" button —
 * while ten other management URLs ("/rep-cost", "/director", "/admin/users" …)
 * refused the same account with "is not part of your access".
 *
 * The office wall itself held: every row was that rep's own state. So this was
 * never a data leak, it was the page catalogue disagreeing with the sidebar
 * about who the Jobs module is for.
 *
 * A single job record is deliberately NOT part of that refusal. A rep opens one
 * from a payout on My commissions and from a card on their own dashboard, and
 * breaking those links to close a menu gap would trade one bug for a worse one.
 */

const page = (id: string): PageDef => {
  const found = PAGES.find((p) => p.id === id);
  if (!found) throw new Error(`no page ${id}`);
  return found;
};

const SELLERS: AppRole[] = ["sales_person", "sales_rep", "outside_sales_rep", "cold_caller"];
const ALLOWED: AppRole[] = ["owner", "admin", "dev", "office", "location_manager", "crew", "field"];

describe("the Jobs module is not a seller's page", () => {
  it("refuses every seller role at /jobs, exactly like /rep-cost", () => {
    for (const role of SELLERS) {
      const jobs = resolvePageAccess({ page: page("jobs"), roles: [role], stored: new Map() });
      const repCost = resolvePageAccess({
        page: page("rep-cost"),
        roles: [role],
        stored: new Map(),
      });
      expect(jobs.allowed, `${role} should not reach the Jobs module`).toBe(false);
      expect(jobs.allowed).toBe(repCost.allowed);
    }
  });

  it("still lets the roles that run jobs open it", () => {
    for (const role of ALLOWED) {
      const r = resolvePageAccess({ page: page("jobs"), roles: [role], stored: new Map() });
      expect(r.allowed, `${role} should reach the Jobs module`).toBe(true);
    }
  });

  it("keeps a single job record open to a seller", () => {
    // /my-commissions links each payout to its job. A rep who cannot open that
    // link cannot check the deal behind their own commission.
    for (const role of SELLERS) {
      const r = resolvePageAccess({ page: page("job-detail"), roles: [role], stored: new Map() });
      expect(r.allowed, `${role} should still open one job`).toBe(true);
    }
  });

  it("routes the list and the record to their own decisions", () => {
    expect(pageForPath("/jobs")?.id).toBe("jobs");
    expect(pageForPath("/jobs/1b000000-0000-4000-8000-000000000011")?.id).toBe("job-detail");
  });

  it("matches the sidebar, which has never offered sellers this entry", () => {
    // app-shell is the other half of the pair. The two drifted once; reading
    // it here is what stops them drifting again.
    const shell = readFileSync("src/components/app-shell.tsx", "utf8");
    const entry = shell.match(/\{\s*to:\s*"\/jobs",[\s\S]{0,220}?\}/);
    expect(entry, "could not find the /jobs nav entry in app-shell").not.toBeNull();
    for (const role of SELLERS) expect(entry![0]).not.toContain(`"${role}"`);
  });
});

describe("the migration that withdraws the stored grant", () => {
  /*
   * defaultRoles only answers when NOTHING is stored, and
   * 20260907190000_page_access_seed.sql stored a `page.jobs` row for every
   * seller role. Without the revoke the code change above decides nothing on a
   * seeded database — which is every real one.
   */
  const sql = readFileSync(
    "supabase/migrations/20260917090000_jobs_page_is_not_for_sellers.sql",
    "utf8",
  );

  it("deletes the page.jobs role grant for each seller role", () => {
    expect(sql).toMatch(/delete\s+from\s+public\.role_permissions/i);
    expect(sql).toMatch(/permission_key\s*=\s*'page\.jobs'/i);
    for (const role of SELLERS) expect(sql).toContain(`'${role}'::public.app_role`);
  });

  it("touches nothing but that grant", () => {
    // No other table, and no personal grants: an individual who genuinely
    // needs the module keeps it through Settings → Access.
    expect(sql).not.toMatch(/\buser_permissions\b/i);
    expect(sql).not.toMatch(/\bdrop\b/i);
    expect(sql.match(/delete\s+from/gi)?.length ?? 0).toBe(1);
  });
});
