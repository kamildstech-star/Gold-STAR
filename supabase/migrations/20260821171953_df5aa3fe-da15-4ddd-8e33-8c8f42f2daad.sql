-- 1. Admin-editable lead source list, seeded from reported source values
INSERT INTO public.option_lists (key, label, description)
VALUES ('lead_source', 'Lead source', 'Where a pipeline account/prospect came from')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active, requires_detail)
SELECT l.id, v.key, v.label, v.sort_order, true, v.requires_detail
FROM public.option_lists l,
  (VALUES
    ('broker','Broker',10,true),
    ('adjuster','Adjuster',20,false),
    ('public_adjuster','Public adjuster',30,true),
    ('past_customer','Past customer',40,false),
    ('property_manager','Property manager',50,true),
    ('chase','Fire chase',60,false),
    ('web','Web',70,false),
    ('phone','Phone',80,false),
    ('walk_in','Called in',90,false),
    ('salesman','Salesman',100,true),
    ('chaveirim','Chaveirim',110,false),
    ('tradeshow','Tradeshow',120,false),
    ('affiliate','Affiliate',130,true),
    ('other','Other',200,true)
  ) AS v(key,label,sort_order,requires_detail)
WHERE l.key = 'lead_source'
ON CONFLICT DO NOTHING;

-- 2. Column on accounts + free-text detail
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS lead_source_id uuid REFERENCES public.option_list_values(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_source_detail text;

CREATE INDEX IF NOT EXISTS accounts_lead_source_id_idx ON public.accounts (lead_source_id);

-- 3. Backfill only what can be inferred
UPDATE public.accounts a
SET lead_source_id = v.id
FROM public.option_list_values v
JOIN public.option_lists l ON l.id = v.list_id AND l.key = 'lead_source'
WHERE v.key = 'tradeshow'
  AND a.lead_source_id IS NULL
  AND a.tradeshow_id IS NOT NULL;

UPDATE public.accounts a
SET lead_source_id = v.id
FROM public.option_list_values v
JOIN public.option_lists l ON l.id = v.list_id AND l.key = 'lead_source'
WHERE v.key = 'affiliate'
  AND a.lead_source_id IS NULL
  AND EXISTS (SELECT 1 FROM public.affiliate_referrals r WHERE r.account_id = a.id);

UPDATE public.accounts a
SET lead_source_id = v.id
FROM public.option_list_values v
JOIN public.option_lists l ON l.id = v.list_id AND l.key = 'lead_source'
WHERE v.key = 'chase'
  AND a.lead_source_id IS NULL
  AND EXISTS (SELECT 1 FROM public.incidents i WHERE i.account_id = a.id);