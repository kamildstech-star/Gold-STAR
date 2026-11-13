ALTER TABLE public.equipment
  ADD COLUMN IF NOT EXISTS tracker_provider text,
  ADD COLUMN IF NOT EXISTS last_lat double precision,
  ADD COLUMN IF NOT EXISTS last_lon double precision,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS tracker_battery_pct integer,
  ADD COLUMN IF NOT EXISTS tracker_heartbeat_status text,
  ADD COLUMN IF NOT EXISTS tracker_location_status text,
  ADD COLUMN IF NOT EXISTS tracker_location_name text,
  ADD COLUMN IF NOT EXISTS tracker_address text,
  ADD COLUMN IF NOT EXISTS tracker_synced_at timestamptz;

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'equipment_offsite';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'equipment_retrieval_overdue';
ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'equipment_idle';

CREATE TABLE IF NOT EXISTS public.equipment_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  kind text NOT NULL,
  placement_id uuid REFERENCES public.equipment_placements(id) ON DELETE SET NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  detail text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  notified_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS equipment_alerts_open_uniq
  ON public.equipment_alerts (equipment_id, kind)
  WHERE resolved_at IS NULL;

GRANT SELECT ON public.equipment_alerts TO authenticated;
GRANT ALL ON public.equipment_alerts TO service_role;
ALTER TABLE public.equipment_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff read equipment alerts in their scope"
  ON public.equipment_alerts FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id));

CREATE POLICY "Privileged manage equipment alerts"
  ON public.equipment_alerts FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

INSERT INTO public.app_settings (key, value)
VALUES ('kahi', jsonb_build_object(
  'hook_url', 'https://project--b0a4cfc7-3fd3-46ba-aa5d-90a925aaa67c.lovable.app/api/public/hooks/kahi-sync',
  'apikey', 'sb_publishable_fAsD3M2I7EBxTfUEexGL0Q_U-DHQ7ua',
  'enabled', true
))
ON CONFLICT (key) DO UPDATE SET value = public.app_settings.value || EXCLUDED.value;

CREATE OR REPLACE FUNCTION public.kahi_sync_kick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE cfg jsonb; hook_url text; hook_key text;
BEGIN
  SELECT value INTO cfg FROM public.app_settings WHERE key = 'kahi';
  IF cfg IS NULL THEN RETURN; END IF;
  IF COALESCE((cfg->>'enabled')::boolean, true) IS FALSE THEN RETURN; END IF;
  hook_url := cfg->>'hook_url';
  hook_key := cfg->>'apikey';
  IF hook_url IS NULL OR hook_key IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url := hook_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'apikey', hook_key),
    body := jsonb_build_object('mode', 'assets')
  );
END; $$;

REVOKE EXECUTE ON FUNCTION public.kahi_sync_kick() FROM anon, PUBLIC;
GRANT EXECUTE ON FUNCTION public.kahi_sync_kick() TO authenticated;

DO $do$
BEGIN
  PERFORM cron.unschedule('kahi-equipment-sync');
EXCEPTION WHEN OTHERS THEN NULL;
END $do$;

SELECT cron.schedule('kahi-equipment-sync', '*/15 * * * *', $cron$SELECT public.kahi_sync_kick();$cron$);