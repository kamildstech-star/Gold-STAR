
-- 1. Catalogue
CREATE TABLE public.permissions (
  key text PRIMARY KEY,
  label text NOT NULL,
  perm_group text NOT NULL DEFAULT 'General',
  description text,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "permissions readable" ON public.permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "permissions manageable" ON public.permissions FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'));
GRANT INSERT, UPDATE, DELETE ON public.permissions TO authenticated;

-- 2. Role defaults
CREATE TABLE public.role_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role public.app_role NOT NULL,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role, permission_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "role_permissions readable" ON public.role_permissions FOR SELECT TO authenticated USING (true);
CREATE POLICY "role_permissions manageable" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'));

-- 3. Per-user overrides
CREATE TABLE public.user_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  effect text NOT NULL DEFAULT 'grant' CHECK (effect IN ('grant','revoke')),
  location_id uuid REFERENCES public.locations(id) ON DELETE CASCADE,
  region_id uuid REFERENCES public.regions(id) ON DELETE CASCADE,
  expires_at timestamptz,
  granted_by uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_permissions_uniq ON public.user_permissions (
  user_id, permission_key, effect,
  COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(region_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX user_permissions_user_idx ON public.user_permissions (user_id, permission_key);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_permissions TO authenticated;
GRANT ALL ON public.user_permissions TO service_role;
ALTER TABLE public.user_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_permissions self read" ON public.user_permissions FOR SELECT TO authenticated
  USING (user_id = (select auth.uid())
     OR public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'));
CREATE POLICY "user_permissions manageable" ON public.user_permissions FOR ALL TO authenticated
  USING (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'))
  WITH CHECK (public.has_role((select auth.uid()), 'owner') OR public.has_role((select auth.uid()), 'admin') OR public.has_role((select auth.uid()), 'dev'));

-- updated_at triggers
CREATE TRIGGER update_permissions_updated_at BEFORE UPDATE ON public.permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_role_permissions_updated_at BEFORE UPDATE ON public.role_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER update_user_permissions_updated_at BEFORE UPDATE ON public.user_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Seed catalogue
INSERT INTO public.permissions (key, label, perm_group, description, sort_order) VALUES
  ('fleet.view','View fleet tracking','Fleet','See vehicle positions and fleet map',10),
  ('fleet.manage','Manage fleet','Fleet','Add, edit and assign vehicles',20),
  ('job.view_costs','View job costs','Money','See cost lines on job records',30),
  ('job.view_margin','View job margin','Money','See margin and profitability figures',40),
  ('labour_rates.view','View labour rates','Money','See configured labour rates',50),
  ('commission.view','View commission','Money','See commission plans and payouts',60),
  ('data.export','Export data','Data','Download contact, account and report exports',70),
  ('expenses.approve','Approve expenses','Operations','Approve expense requests above threshold',80),
  ('users.manage','Manage users','Admin','Create users, assign roles and locations',90),
  ('compliance.manage','Manage compliance','Operations','Edit credentials, requirements and networks',100),
  ('automation.manage','Manage automations','Admin','Create and edit automation rules',110),
  ('reports.view_all_locations','Reports across all locations','Reporting','See reporting beyond own location scope',120),
  ('chase.view_tracking','View chaser tracking','Operations','See chaser locations and duty tracking',130),
  ('ai.assistant','Use AI assistant','AI','Access the AI assistant and pre-call briefs',140);

-- 5. Seed role defaults
INSERT INTO public.role_permissions (role, permission_key)
SELECT r.role::public.app_role, p.key FROM public.permissions p
CROSS JOIN (VALUES ('owner'),('admin'),('dev')) AS r(role)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission_key) VALUES
  ('sales_head','fleet.view'),('sales_head','job.view_costs'),('sales_head','job.view_margin'),
  ('sales_head','labour_rates.view'),('sales_head','commission.view'),('sales_head','data.export'),
  ('sales_head','expenses.approve'),('sales_head','compliance.manage'),('sales_head','automation.manage'),
  ('sales_head','reports.view_all_locations'),('sales_head','chase.view_tracking'),('sales_head','ai.assistant'),
  ('regional','fleet.view'),('regional','job.view_costs'),('regional','job.view_margin'),
  ('regional','labour_rates.view'),('regional','expenses.approve'),('regional','compliance.manage'),
  ('regional','reports.view_all_locations'),('regional','chase.view_tracking'),('regional','ai.assistant'),
  ('location_manager','fleet.view'),('location_manager','job.view_costs'),('location_manager','job.view_margin'),
  ('location_manager','labour_rates.view'),('location_manager','expenses.approve'),
  ('location_manager','compliance.manage'),('location_manager','chase.view_tracking'),('location_manager','ai.assistant'),
  ('sales_manager','job.view_costs'),('sales_manager','job.view_margin'),('sales_manager','commission.view'),
  ('sales_manager','data.export'),('sales_manager','chase.view_tracking'),('sales_manager','ai.assistant'),
  ('office','job.view_costs'),('office','compliance.manage'),('office','ai.assistant'),
  ('sales_person','ai.assistant'),
  ('outside_sales_rep','ai.assistant'),
  ('cold_caller','ai.assistant'),
  ('sales_rep','ai.assistant'),
  ('field_chaser','ai.assistant')
ON CONFLICT DO NOTHING;

-- 6. Effective permission helper
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _key text, _location_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    -- explicit revoke wins
    NOT EXISTS (
      SELECT 1 FROM public.user_permissions up
      WHERE up.user_id = _user_id
        AND up.permission_key = _key
        AND up.effect = 'revoke'
        AND (up.expires_at IS NULL OR up.expires_at > now())
        AND (
          (up.location_id IS NULL AND up.region_id IS NULL)
          OR (_location_id IS NOT NULL AND up.location_id = _location_id)
          OR (_location_id IS NOT NULL AND up.region_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.location_regions lr
                WHERE lr.location_id = _location_id AND lr.region_id = up.region_id))
        )
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.user_roles ur
        JOIN public.role_permissions rp ON rp.role = ur.role
        WHERE ur.user_id = _user_id AND rp.permission_key = _key
      )
      OR EXISTS (
        SELECT 1 FROM public.user_permissions up
        WHERE up.user_id = _user_id
          AND up.permission_key = _key
          AND up.effect = 'grant'
          AND (up.expires_at IS NULL OR up.expires_at > now())
          AND (
            (up.location_id IS NULL AND up.region_id IS NULL)
            OR (_location_id IS NOT NULL AND up.location_id = _location_id)
            OR (_location_id IS NOT NULL AND up.region_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.location_regions lr
                  WHERE lr.location_id = _location_id AND lr.region_id = up.region_id))
          )
      )
    )
$$;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text, uuid) TO authenticated, service_role;

-- 7. Effective permissions with source, for the admin UI
CREATE OR REPLACE FUNCTION public.effective_permissions(_user_id uuid)
RETURNS TABLE (
  permission_key text,
  label text,
  perm_group text,
  allowed boolean,
  source text,
  source_role public.app_role,
  location_id uuid,
  region_id uuid,
  expires_at timestamptz,
  granted_by uuid,
  reason text,
  override_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH roles AS (
    SELECT DISTINCT rp.permission_key, ur.role
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = _user_id
  ),
  ov AS (
    SELECT DISTINCT ON (up.permission_key) up.*
    FROM public.user_permissions up
    WHERE up.user_id = _user_id
      AND (up.expires_at IS NULL OR up.expires_at > now())
    ORDER BY up.permission_key, (up.effect = 'revoke') DESC, up.created_at DESC
  )
  SELECT
    p.key,
    p.label,
    p.perm_group,
    CASE
      WHEN ov.effect = 'revoke' THEN false
      WHEN ov.effect = 'grant' THEN true
      ELSE EXISTS (SELECT 1 FROM roles r WHERE r.permission_key = p.key)
    END,
    CASE
      WHEN ov.effect = 'revoke' THEN 'revoked'
      WHEN ov.effect = 'grant' THEN 'granted'
      WHEN EXISTS (SELECT 1 FROM roles r WHERE r.permission_key = p.key) THEN 'role'
      ELSE 'none'
    END,
    (SELECT r.role FROM roles r WHERE r.permission_key = p.key LIMIT 1),
    ov.location_id, ov.region_id, ov.expires_at, ov.granted_by, ov.reason, ov.id
  FROM public.permissions p
  LEFT JOIN ov ON ov.permission_key = p.key
  ORDER BY p.perm_group, p.sort_order
$$;
GRANT EXECUTE ON FUNCTION public.effective_permissions(uuid) TO authenticated, service_role;

-- 8. Audit permission changes into role_change_audit
CREATE OR REPLACE FUNCTION public.audit_user_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, new_value)
    VALUES (NEW.user_id, (select auth.uid()),
            CASE WHEN NEW.effect = 'revoke' THEN 'permission_revoked' ELSE 'permission_granted' END,
            'user_permissions', to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, old_value, new_value)
    VALUES (NEW.user_id, (select auth.uid()), 'permission_changed', 'user_permissions', to_jsonb(OLD), to_jsonb(NEW));
    RETURN NEW;
  ELSE
    INSERT INTO public.role_change_audit (target_user_id, actor_id, action, entity, old_value)
    VALUES (OLD.user_id, (select auth.uid()), 'permission_removed', 'user_permissions', to_jsonb(OLD));
    RETURN OLD;
  END IF;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.audit_user_permissions() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_user_permissions_trg
AFTER INSERT OR UPDATE OR DELETE ON public.user_permissions
FOR EACH ROW EXECUTE FUNCTION public.audit_user_permissions();

CREATE OR REPLACE FUNCTION public.audit_role_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.role_change_audit (actor_id, action, entity, old_value)
    VALUES ((select auth.uid()), 'role_permission_removed', 'role_permissions', to_jsonb(OLD));
    RETURN OLD;
  END IF;
  INSERT INTO public.role_change_audit (actor_id, action, entity, new_value)
  VALUES ((select auth.uid()), 'role_permission_added', 'role_permissions', to_jsonb(NEW));
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.audit_role_permissions() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_role_permissions_trg
AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
FOR EACH ROW EXECUTE FUNCTION public.audit_role_permissions();
