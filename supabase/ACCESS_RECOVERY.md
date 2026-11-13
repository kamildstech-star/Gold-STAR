# Access recovery — getting back into Settings → Access

Almost everything on **Settings → Access** (`/admin/permissions`) is a switch,
including the Access screen itself. That is deliberate: Mark asked for a screen
with no locks on it. So it is possible to switch the Access page off for
everybody, and the screen that would undo it is the screen that was switched
off.

**Start here: the `dev` role is the break-glass.** Sign in as somebody holding
it. If nobody holds it, the SQL further down is the last resort.

---

## The break-glass role

`dev` is the one role that is not a switch.

- **It reaches every page and every capability, from code.** `src/lib/page-access.ts`
  short-circuits it before any stored row is consulted (rule 0 in
  `resolvePageAccess`), and `useMyPermissions` does the same for capabilities.
  A cleared role row does not remove it. A personal revoke does not override
  it. Neither does the Access screen, which draws the Developer role read-only
  with a padlock.
- **The database enforces the same thing.** Migration
  `20260909190000_dev_break_glass.sql` adds triggers so that, even in the SQL
  editor with full rights:
  - a `role_permissions` row for `dev` cannot be deleted or reassigned;
  - a new row in `permissions` gets a `dev` grant automatically;
  - a `user_permissions` row with `effect = 'revoke'` cannot be written against
    anybody holding `dev`, and granting `dev` clears any revoke already on them.

  So "it cannot be changed" is not just a claim the interface makes.
- **The way to withdraw it is the role itself.** Taking `dev` off a person is an
  ordinary `user_roles` change, on their user page. That is the intended escape
  hatch from the escape hatch, and it is the only one.

**So the first question is who holds it.**

```sql
select p.user_id, p.full_name, p.email, p.is_active
from public.profiles p
join public.user_roles ur on ur.user_id = p.user_id and ur.role = 'dev'
order by p.is_active desc, p.full_name;
```

Any active row there is your way in: that person signs in and switches the
Access page back on for Admin, on the Roles tab, like any other change. Nothing
below is needed.

The app says the same thing before the fact. Switching the Access page off for
the last role that carries it shows a confirm step — and because a `dev` holder
is counted as somebody who can still get in, **that confirm only appears when
nobody active holds `dev` either**. When it does appear it says so, and the
cheapest fix is to cancel and give somebody the Developer role first.

### Still true, and worth saying

- **There is no service path in the app.** `SUPABASE_SERVICE_ROLE_KEY` is used
  by server functions, but nothing in the interface exposes a route that
  bypasses page access.
- **Row-level security is unaffected either way.** Page access is a routing and
  interface control. Losing the Access page does not expose or protect data;
  it only stops people opening the screen.

---

## Last resort: nobody holds `dev`

If the query above returns no active person, the SQL below is the way back. It
is run by anyone with Supabase access to the project (SQL Editor → New query,
or `psql`).

Often the shortest fix is to grant the role rather than repair the rows — one
statement, and the app is recoverable from then on:

```sql
insert into public.user_roles (user_id, role)
values ('<the user id>', 'dev'::public.app_role)
on conflict do nothing;
```

Otherwise, work through the sections below.

---

## 1. Who can currently reach the Access page?

Run this first. It tells you whether you actually have a problem, and if so
whether the cause is a missing role row or a personal revoke.

```sql
-- Active people who can open AND edit Settings → Access, ignoring the dev
-- break-glass (anyone holding dev is already covered by the query above, and
-- reaches the page whatever these rows say).
-- All three conditions are enforced somewhere in the app:
--   * the account is active,
--   * the person holds owner / admin (every other role is shown the
--     job-fields panel only, even with the page granted),
--   * page.admin-access resolves allowed for them.
select p.user_id,
       p.full_name,
       array_agg(distinct ur.role::text order by ur.role::text) as roles
from public.profiles p
join public.user_roles ur on ur.user_id = p.user_id
where p.is_active
  and ur.role in ('owner', 'admin')
  -- not personally revoked
  and not exists (
    select 1 from public.user_permissions up
    where up.user_id = p.user_id
      and up.permission_key = 'page.admin-access'
      and up.effect = 'revoke'
      and (up.expires_at is null or up.expires_at > now())
  )
  -- carried by one of their roles, or by a personal grant
  and (
    exists (
      select 1 from public.role_permissions rp
      join public.user_roles ur2 on ur2.user_id = p.user_id and ur2.role = rp.role
      where rp.permission_key = 'page.admin-access'
    )
    or exists (
      select 1 from public.user_permissions up
      where up.user_id = p.user_id
        and up.permission_key = 'page.admin-access'
        and up.effect = 'grant'
        and (up.expires_at is null or up.expires_at > now())
    )
  )
group by p.user_id, p.full_name
order by p.full_name;
```

**Zero rows means nobody can get in.** Continue below.

---

## 2. Put the Access page back

The usual case: the role row was cleared. Give it back to `admin` (and to
`owner` and `dev` while you are there — it costs nothing and saves a second
round trip).

```sql
insert into public.role_permissions (role, permission_key)
values ('owner'::public.app_role, 'page.admin-access'),
       ('admin'::public.app_role, 'page.admin-access'),
       ('dev'::public.app_role,   'page.admin-access')
on conflict (role, permission_key) do nothing;
```

Re-runnable, and it does not disturb anything else.

### If the block was personal rather than role-wide

A personal **revoke** beats a role grant, so an administrator can be shut out
individually even while their role carries the page. Clear it:

```sql
delete from public.user_permissions
where permission_key = 'page.admin-access'
  and effect = 'revoke'
  and user_id = '<the user id>';   -- omit this line to clear every such revoke
```

### If somebody also cleared `/admin` itself

`/admin/permissions` sits inside the Settings frame, which is gated by
`page.admin`. If that was cleared too, the Access page alone is not enough:

```sql
insert into public.role_permissions (role, permission_key)
values ('owner'::public.app_role, 'page.admin'),
       ('admin'::public.app_role, 'page.admin'),
       ('dev'::public.app_role,   'page.admin')
on conflict (role, permission_key) do nothing;
```

### Nuclear option: restore every page for the privileged roles

If access was cleared wholesale and you just want the administrators working
again, this restores each of the three roles to every page in the catalogue.
It only ever adds; nobody else's access is touched.

```sql
insert into public.role_permissions (role, permission_key)
select r.role, p.key
from public.permissions p
cross join (values ('owner'::public.app_role), ('admin'::public.app_role), ('dev'::public.app_role))
     as r(role)
where p.key like 'page.%'
on conflict (role, permission_key) do nothing;
```

---

## 3. Confirm, then reload

Re-run the query in step 1. Once it returns at least one active person, that
person signs out and back in (or hard-reloads) — the client caches permissions
for a minute — and Settings → Access opens again.

---

## Notes for whoever is reading this at 2am

- **Every one of these statements is safe to run twice.** They insert with
  `on conflict do nothing` or delete a specific override.
- **They are not migrations.** Do not add them to `supabase/migrations/`; they
  repair one database's data, they are not part of the schema. The seed that
  establishes these rows normally is
  `supabase/migrations/20260907190000_page_access_seed.sql`.
- **The three essential pages are togglable too.** Dashboard (`/`),
  Notifications (`/notifications`) and My account security (`/security`) are
  ordinary switches now. Switching `/security` off for a role means those people
  cannot manage their own two-factor settings; the row on the Access screen says
  so. Restore any of them the same way — the keys are `page.dashboard`,
  `page.notifications`, `page.account-security`.
- **A page that has never been seeded is not denied.** The resolver falls back
  to the page's built-in default (`defaultRoles` in `src/lib/page-access.ts`),
  which always includes Owner, Admin and Developer, so adding a page in code
  never locks administrators out before somebody remembers to tick it. Only a
  row that actually exists can deny — and for `dev`, not even that.
- **Some of these statements will be refused for `dev`.** Anything that deletes
  a `dev` row from `role_permissions`, or writes a revoke against a `dev`
  holder, raises `42501` by design. That is the break-glass working, not a
  broken database. If you genuinely need to strip a `dev` account, remove the
  role from `public.user_roles` first.
