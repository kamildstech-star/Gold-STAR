-- Reasons for moving an active client back onto the Prospecting pipeline
-- (decided with the client 2026-09-03). Data only — no table or column
-- changes. The app falls back to the same six options in code
-- (src/lib/pipeline-reversion.ts) until this is applied; once applied the
-- list is administrable under Settings → Dropdown options.
--
-- WRITTEN, NOT APPLIED.

INSERT INTO public.option_lists (key, label, description, allow_location_scope)
VALUES (
  'pipeline_reversion_reason',
  'Back-to-pipeline reason',
  'Why an active client was moved back onto the Prospecting pipeline. Written to the account''s stage history.',
  false
)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active, is_default, requires_detail)
SELECT ol.id, x.k, x.l, x.o, true, false, x.d
FROM public.option_lists ol,
     (VALUES ('deal_fell_through',      'Deal fell through',                    10, false),
             ('relationship_reset',     'Relationship reset — starting over',   20, false),
             ('contract_ended',         'Contract or engagement ended',         30, false),
             ('decision_maker_changed', 'Decision maker changed',               40, false),
             ('went_with_competitor',   'Went with a competitor',               50, false),
             ('other',                  'Other',                                60, true)) AS x(k, l, o, d)
WHERE ol.key = 'pipeline_reversion_reason'
ON CONFLICT DO NOTHING;
