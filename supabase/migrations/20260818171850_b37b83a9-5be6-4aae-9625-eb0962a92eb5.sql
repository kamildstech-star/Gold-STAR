CREATE OR REPLACE FUNCTION public.chase_settings_defaults()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'escalation_interval_seconds', 90,
    'live_lock_grace_minutes', 15,
    'overnight_lock_hours', 4,
    'lead_decay_hours', 24,
    'dedupe_window_minutes', 60,
    'default_exclusivity', 'exclusive',
    'overnight_severity_floor', 'other',
    'search_window_days', 14,
    'search_result_limit', 20,
    'search_min_chars', 3,
    'past_lead_retention_days', 90,
    'exposure_multi_family_units', 6,
    'exposure_row_house_span', 2,
    'exposure_semi_detached_span', 1,
    'exposure_detached_nearby', 4
  )
$$;