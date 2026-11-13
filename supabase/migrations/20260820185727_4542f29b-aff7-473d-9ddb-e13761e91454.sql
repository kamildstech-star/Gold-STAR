
CREATE TABLE public.layout_defaults (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  role_key text NOT NULL DEFAULT 'all',
  payload jsonb NOT NULL,
  published_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, role_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.layout_defaults TO authenticated;
GRANT ALL ON public.layout_defaults TO service_role;
ALTER TABLE public.layout_defaults ENABLE ROW LEVEL SECURITY;

CREATE POLICY "layout_defaults_read" ON public.layout_defaults
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "layout_defaults_write" ON public.layout_defaults
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.layout_default_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  role_key text NOT NULL,
  action text NOT NULL,
  affected_users integer,
  payload jsonb,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.layout_default_events TO authenticated;
GRANT ALL ON public.layout_default_events TO service_role;
ALTER TABLE public.layout_default_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "layout_default_events_read" ON public.layout_default_events
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "layout_default_events_insert" ON public.layout_default_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_id = auth.uid()
    AND (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'owner'::app_role))
  );

CREATE OR REPLACE FUNCTION public.count_layout_overrides(_scope text, _role_key text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF _scope = 'dashboard' THEN
    SELECT count(DISTINCT d.user_id) INTO n
    FROM public.dashboard_layouts d
    WHERE (_role_key = 'all' OR d.role_key = _role_key)
      AND (
        _role_key = 'all'
        OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = d.user_id AND r.role::text = _role_key)
      );
  ELSE
    SELECT count(DISTINCT p.user_id) INTO n
    FROM public.user_view_prefs p
    WHERE p.scope = (CASE WHEN _scope = 'sidebar' THEN 'sidebar_order' ELSE 'hidden_sections' END)
      AND (
        _role_key = 'all'
        OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role::text = _role_key)
      );
  END IF;

  RETURN coalesce(n, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.reset_layout_overrides(_scope text, _role_key text)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer := 0;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'admin'::app_role) OR public.has_role(auth.uid(), 'owner'::app_role)) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  n := public.count_layout_overrides(_scope, _role_key);

  IF _scope = 'dashboard' THEN
    DELETE FROM public.dashboard_layouts d
    WHERE (_role_key = 'all' OR d.role_key = _role_key)
      AND (
        _role_key = 'all'
        OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = d.user_id AND r.role::text = _role_key)
      );
  ELSE
    DELETE FROM public.user_view_prefs p
    WHERE p.scope = (CASE WHEN _scope = 'sidebar' THEN 'sidebar_order' ELSE 'hidden_sections' END)
      AND (
        _role_key = 'all'
        OR EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role::text = _role_key)
      );
  END IF;

  INSERT INTO public.layout_default_events (scope, role_key, action, affected_users, actor_id)
  VALUES (_scope, _role_key, 'reset_all', n, auth.uid());

  RETURN n;
END;
$$;
