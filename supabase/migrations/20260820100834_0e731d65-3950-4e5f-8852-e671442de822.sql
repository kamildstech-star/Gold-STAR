CREATE TABLE IF NOT EXISTS public.user_device_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  platform text,
  user_agent text,
  primed_at timestamptz,
  location_state text NOT NULL DEFAULT 'unknown',
  notifications_state text NOT NULL DEFAULT 'unknown',
  location_denied_at timestamptz,
  notifications_denied_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

GRANT SELECT, INSERT, UPDATE ON public.user_device_permissions TO authenticated;
GRANT ALL ON public.user_device_permissions TO service_role;

ALTER TABLE public.user_device_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own device permissions" ON public.user_device_permissions
  FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "privileged can read device permissions" ON public.user_device_permissions
  FOR SELECT TO authenticated USING (
    public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'owner')
  );

CREATE TRIGGER user_device_permissions_updated_at
  BEFORE UPDATE ON public.user_device_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();