WITH loc AS (SELECT id FROM public.locations ORDER BY name LIMIT 1),
ins AS (
  INSERT INTO public.affiliate_reps (full_name, company, email, phone, location_id, payout_terms, commission_rate, status, is_demo)
  SELECT v.full_name, v.company, v.email, v.phone, loc.id, 'Net 30', v.rate, 'active', true
  FROM loc, (VALUES
    ('Marcus Webb','Webb Plumbing & Drain','marcus@webbplumbing.example','718-555-0142', 5),
    ('Dana Ortiz','Ortiz Public Adjusters','dana@ortizpa.example','410-555-0119', 7),
    ('Priya Raman','Raman Property Group','priya@ramanpg.example','847-555-0177', 4),
    ('Tom Kessler','Kessler Roofing','tom@kesslerroofing.example','313-555-0188', 6),
    ('Alicia Brooks','Brooks Insurance Brokers','alicia@brooksib.example','832-555-0163', 8)
  ) AS v(full_name, company, email, phone, rate)
  RETURNING id, full_name
)
INSERT INTO public.affiliate_referrals (affiliate_id, description, referred_on, amount_owed, status, is_demo)
SELECT ins.id,
       'Referred water damage claim',
       (current_date - (g.n * 4))::date,
       round((900 + random() * 2600)::numeric, 0),
       CASE WHEN g.n % 3 = 0 THEN 'won' ELSE 'open' END,
       true
FROM ins
CROSS JOIN generate_series(1, 4) AS g(n);