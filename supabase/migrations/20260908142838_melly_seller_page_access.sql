-- Melly's sales workflow is shared by all relationship-owning seller roles.
-- The original page seed only granted these pages to the legacy `sales_rep`
-- role, leaving the current `sales_person` and `outside_sales_rep` roles with
-- a nearly empty sidebar. Personal revocations still win in
-- effective_permissions(); these are role defaults only.

-- Production may not yet have received the earlier full page-catalogue seed.
-- Seed just this workflow's catalogue keys so the role-permission foreign key
-- is satisfied without depending on migration delivery order across PRs.
INSERT INTO public.permissions (key, label, perm_group, description, sort_order) VALUES
  ('page.pipeline', 'Pipeline', 'Pages · Sales', 'Page: /pipeline', 3008),
  ('page.active-clients', 'Active Clients', 'Pages · Sales', 'Page: /farming', 3009),
  ('page.routes', 'Routes', 'Pages · Sales', 'Page: /routes', 3010),
  ('page.tradeshows', 'Tradeshows', 'Pages · Sales', 'Page: /tradeshows', 3011),
  ('page.calendar', 'Calendar', 'Pages · Team', 'Page: /calendar', 7050),
  ('page.tasks', 'Tasks', 'Pages · Team', 'Page: /tasks', 7052),
  ('page.chat', 'Chat', 'Pages · Team', 'Page: /chat', 7054)
ON CONFLICT (key) DO UPDATE SET
  label = EXCLUDED.label,
  perm_group = EXCLUDED.perm_group,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  ('sales_person'::public.app_role, 'page.pipeline'),
  ('outside_sales_rep'::public.app_role, 'page.pipeline'),
  ('sales_person'::public.app_role, 'page.active-clients'),
  ('outside_sales_rep'::public.app_role, 'page.active-clients'),
  ('sales_person'::public.app_role, 'page.routes'),
  ('outside_sales_rep'::public.app_role, 'page.routes'),
  ('sales_person'::public.app_role, 'page.tradeshows'),
  ('outside_sales_rep'::public.app_role, 'page.tradeshows'),
  ('sales_person'::public.app_role, 'page.calendar'),
  ('outside_sales_rep'::public.app_role, 'page.calendar'),
  ('sales_person'::public.app_role, 'page.tasks'),
  ('outside_sales_rep'::public.app_role, 'page.tasks'),
  ('sales_person'::public.app_role, 'page.chat'),
  ('outside_sales_rep'::public.app_role, 'page.chat')
ON CONFLICT (role, permission_key) DO NOTHING;
