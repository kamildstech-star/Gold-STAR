-- EXAMPLE supply catalogue rows — for testing the new request form only.
--
-- David asked for the ordering form to be redesigned before the real catalogue
-- exists; his own item list is coming as a spreadsheet. Inventing a hundred
-- plausible item names would be worse than none — somebody would order from it.
-- So this is a DELIBERATELY TINY set, six rows across three categories, whose
-- only job is to show that the form groups by category and that a category with
-- one item looks right next to one with three.
--
-- Every row is marked twice: the sku begins with EXAMPLE- and the name ends
-- with "(example)". To clear them once the real catalogue lands:
--
--   DELETE FROM public.supply_items WHERE sku LIKE 'EXAMPLE-%';
--
-- Depends on 20260918090000 for the sku and default_supplier columns. It is
-- separate from that migration so the schema can be applied without the
-- example data.

INSERT INTO public.supply_items (name, unit, category, sku, default_supplier, sort_order, is_active)
VALUES
  ('Nitrile gloves, box of 100 (example)', 'box',  'PPE',          'EXAMPLE-PPE-001', 'Home Depot',    10, true),
  ('N95 respirator (example)',             'each', 'PPE',          'EXAMPLE-PPE-002', 'Grainger',      20, true),
  ('Tyvek suit, XL (example)',             'each', 'PPE',          'EXAMPLE-PPE-003', 'Grainger',      30, true),
  ('Contractor bags, 42 gal (example)',    'roll', 'Containment',  'EXAMPLE-CON-001', 'Home Depot',    10, true),
  ('Poly sheeting, 6 mil (example)',       'roll', 'Containment',  'EXAMPLE-CON-002', 'Home Depot',    20, true),
  ('Dehumidifier filter (example)',        'each', 'Equipment',    'EXAMPLE-EQP-001', 'Jon-Don',       10, true)
ON CONFLICT DO NOTHING;
