UPDATE public.app_settings
SET value = jsonb_set(
  jsonb_set(value, '{hook_url}', to_jsonb('https://goldstar.falconstaging.com/api/public/hooks/raven-sync'::text), true),
  '{trips_enabled}',
  'false'::jsonb,
  true
),
updated_at = now()
WHERE key = 'raven';