import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const original = readFileSync(
  new URL("../../supabase/migrations/20260903172802_job_calculations.sql", import.meta.url),
  "utf8",
);
const correction = readFileSync(
  new URL(
    "../../supabase/migrations/20260903181541_secure_job_calculation_policy_and_grants.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("job_calculations migration security", () => {
  it.each([
    ["original", original],
    ["corrective", correction],
  ])("qualifies both sides of the job/location relationship in the %s migration", (_name, sql) => {
    expect(sql).toContain("j.id = job_calculations.job_id");
    expect(sql).toContain("j.location_id = job_calculations.location_id");
    expect(sql).not.toMatch(/j\.location_id\s*=\s*location_id\b/);
  });

  it.each([
    ["original", original],
    ["corrective", correction],
  ])(
    "removes default authenticated privileges before granting CRUD in the %s migration",
    (_name, sql) => {
      const revoke = sql.indexOf("revoke all on table public.job_calculations from authenticated;");
      const grant = sql.indexOf(
        "grant select, insert, update, delete on table public.job_calculations to authenticated;",
      );

      expect(revoke).toBeGreaterThanOrEqual(0);
      expect(grant).toBeGreaterThan(revoke);
      expect(sql).not.toMatch(/grant\s+[^;]*(references|trigger|truncate)[^;]*to authenticated/i);
    },
  );

  it("can safely replace both affected policies when rerun", () => {
    for (const policy of ["job_calculations_insert", "job_calculations_update"]) {
      const drop = correction.indexOf(`drop policy if exists ${policy}`);
      const create = correction.indexOf(`create policy ${policy}`);
      expect(drop).toBeGreaterThanOrEqual(0);
      expect(create).toBeGreaterThan(drop);
    }
  });

  it("adds job date for both clean installs and the already-applied schema", () => {
    expect(original).toContain("job_date date not null default current_date");
    const jobDateMigration = readFileSync(
      new URL(
        "../../supabase/migrations/20260903182122_add_job_date_to_calculations.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(jobDateMigration).toMatch(
      /add column if not exists job_date date not null default current_date;/,
    );
  });
});
