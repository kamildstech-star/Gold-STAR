ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS insurance_kind text,
  ADD COLUMN IF NOT EXISTS insurance_kind_detail text;

INSERT INTO public.option_lists (key, label, description)
VALUES ('insurance_kind', 'Insurance kind', 'Policy type behind an insurance job — changes who pays and what is covered.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, is_default, requires_detail)
SELECT l.id, v.key, v.label, v.sort_order, v.is_default, v.requires_detail
FROM public.option_lists l
CROSS JOIN (VALUES
  ('homeowners', 'Homeowner''s policy', 10, true, false),
  ('renters', 'Renter''s policy', 20, false, false),
  ('commercial', 'Commercial policy', 30, false, false),
  ('other', 'Other', 40, false, true)
) AS v(key, label, sort_order, is_default, requires_detail)
WHERE l.key = 'insurance_kind'
ON CONFLICT DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, is_default, requires_detail)
SELECT l.id, 'undetermined', 'Undetermined', 30, false, false
FROM public.option_lists l
WHERE l.key = 'job_type'
ON CONFLICT DO NOTHING;