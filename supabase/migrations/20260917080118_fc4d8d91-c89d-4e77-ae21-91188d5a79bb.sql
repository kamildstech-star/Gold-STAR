-- The Jobs module was reachable by every seller role.
--
-- The sidebar has never offered /jobs to a seller — app-shell gives that entry
-- to management and crew — but the page catalogue disagreed, and the catalogue
-- is what the route gate reads. A New York sales rep whose menu has no Jobs
-- link could type /jobs and land on the full module, "New job" button and all,
-- while ten other management URLs refused the same account. The office wall
-- held (only that rep's own state's jobs were listed), so this is a page-access
-- gap, not a data leak.
--
-- The built-in defaults in src/lib/page-access.ts are fixed in the same commit.
-- Those only answer when NOTHING is stored, and 20260907190000_page_access_seed
-- stored a row for each seller role, so the grant has to be withdrawn here too
-- or the code change decides nothing.
--
-- Individual job records are NOT affected. `/jobs/<id>` is now its own
-- catalogue entry ("job-detail") which sellers keep, because a rep opens a job
-- from their own commission payout and from their dashboard. That entry is
-- deliberately not seeded into `permissions`: with no row stored it answers
-- from the built-in defaults, which allow it.
--
-- Personal grants are untouched: if an individual seller genuinely needs the
-- Jobs module, grant it to that person under Settings → Access rather than
-- handing it back to every seller role.

DELETE FROM public.role_permissions
WHERE permission_key = 'page.jobs'
  AND role IN (
    'sales_person'::public.app_role,
    'sales_rep'::public.app_role,
    'outside_sales_rep'::public.app_role,
    'cold_caller'::public.app_role
  );