ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS size text;

COMMENT ON COLUMN public.supply_items.size IS
  'Size exactly as the client''s sheet types it: 2"x60 Yard, 21x19x2, 10QT. Display only — never parsed.';

DROP INDEX IF EXISTS public.supply_items_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS supply_items_name_size_key
  ON public.supply_items (lower(name), lower(coalesce(size, '')));

UPDATE public.supply_request_lines l
   SET other_label = i.name
  FROM public.supply_items i
 WHERE i.id = l.item_id
   AND i.sku LIKE 'EXAMPLE-%'
   AND nullif(btrim(coalesce(l.other_label, '')), '') IS NULL;

UPDATE public.supply_purchases p
   SET item_label = i.name
  FROM public.supply_items i
 WHERE i.id = p.item_id
   AND i.sku LIKE 'EXAMPLE-%'
   AND nullif(btrim(coalesce(p.item_label, '')), '') IS NULL;

DELETE FROM public.supply_items WHERE sku LIKE 'EXAMPLE-%';

INSERT INTO public.supply_items (name, size, unit, category, sort_order)
VALUES
  ('Duct Tape', '2"x60 Yard', '24 Case', 'Adhesive', 10),
  ('Painters Tape', '2"x60 Yard', '24 Case', 'Adhesive', 20),
  ('Yellow Tape  Serrated For Ram Board', '3"x60 Yard', '16 Case', 'Adhesive', 30),
  ('Yellow Tape  Serrated For Ram Board', '2"x60 Yard', '24 Case', 'Adhesive', 40),
  ('Red Tape  Serrated For Ram Board', '3"x60 Yard', '16 Case', 'Adhesive', 50),
  ('Red Tape Serrated For Ram Board', '2"x60 Yard', '24 Case', 'Adhesive', 60),
  ('Spray Adhesive', '12 oz.', '12 Case', 'Adhesive', 70),
  ('Containment Zippers 2pk', '3"x84"', '48 Case', 'Adhesive', 80),
  ('9D9', '1 Gallon', '4 Case', 'Chemicals', 10),
  ('Benefect Botanical Decon 30', '1 Gallon', '4 Case', 'Chemicals', 20),
  ('Unsmoke Degrease all', '1 Gallon', '4 Case', 'Chemicals', 30),
  ('Defoamer- General carpet cleaning', NULL, 'each', 'Chemicals', 40),
  ('Fiberlock Recon', '5 Gallon', 'Each', 'Chemicals', 50),
  ('First Defense 40-80 Disinfectant', '5 Gallon', 'Each', 'Chemicals', 60),
  ('IAQ 1000', '5 Gallon', 'Each', 'Chemicals', 70),
  ('IAQ 6000 Mold Encapsulate (white)', '5 Gallon', 'Each', 'Chemicals', 80),
  ('IAQ 6100 Mold Encapsulate (Clear)', '5 Gallon', 'Each', 'Chemicals', 90),
  ('IAQ Advanced Peroxide', '2.5 Gallon', '2 Case', 'Chemicals', 100),
  ('Instant Mold Stain Remover', '1 Gallon', '4 Case', 'Chemicals', 110),
  ('OdorX Bad Odor Blocks (Cherry)', NULL, '25 Case', 'Chemicals', 120),
  ('OdorX Bad Odor Blocks (Lemon)', NULL, '25 Case', 'Chemicals', 130),
  ('OdorX Bad Odor Blocks (Vanilla)', NULL, '25 Case', 'Chemicals', 140),
  ('OdorX Thermo 55 Cherry', '1 Gallon', '4 Case', 'Chemicals', 150),
  ('OdorX Un-duzit-unleashed', '1 Gallon', '4 Case', 'Chemicals', 160),
  ('Peroxide 3%', NULL, 'each', 'Chemicals', 170),
  ('Pool Oxidizer', NULL, 'each', 'Chemicals', 180),
  ('Shockwave Concentrate', '10oz.', '24 Case', 'Chemicals', 190),
  ('Shockwave Concentrate', '1 Gallon', '4 Case', 'Chemicals', 200),
  ('Shockwave RTU', '1 Gallon', '4 Case', 'Chemicals', 210),
  ('Unleashed - urine carpet cleaning', '1 Gallon', '4 Case', 'Chemicals', 220),
  ('Wall Wash with Biosolve', '1 Gallon', '4 Case', 'Chemicals', 230),
  ('Lay Flat Ducting 4mil', '13x500', '1 Roll', 'Plastic', 10),
  ('Lay Flat Ducting 2mil', '16x500', '1 Roll', 'Plastic', 20),
  ('Lay Flat Ducting 2mil', '22x500', '1 Roll', 'Plastic', 30),
  ('Garbage Bags', NULL, '1 Roll', 'Plastic', 40),
  ('Containment Plastic', '10x100', '1 Roll', 'Plastic', 50),
  ('Carpet Film', '36x200', '1 Roll', 'Plastic', 60),
  ('Floor Shell H/D Surface Protector', '38x100', 'each', 'Plastic', 70),
  ('Painters Plastic', '9x400', 'each', 'Plastic', 80),
  ('Painters Plastic', '12x400', 'each', 'Plastic', 90),
  ('Filter', '11x10x1', 'each', 'Filters', 10),
  ('Pleated Filter Merv 8', '12x12x1', '12 case', 'Filters', 20),
  ('Pleated Filter Merv 10', '12x14x1', '12 Case', 'Filters', 30),
  ('Pleated Filter Merv 8', '18x18x1', 'each', 'Filters', 40),
  ('Pleated Filter Merv 8', '21x19x1', '12 Case', 'Filters', 50),
  ('Pleated Filter Merv 8', '21x19x2', '6 case', 'Filters', 60),
  ('Pleated Filter Merv 8', '24x24x2', '8 Case', 'Filters', 70),
  ('Carbon Filter (Activated Carbon)', '16x16x1', '4 Case', 'Filters', 80),
  ('Carbon Filter (Activated Carbon)', '18x18x1', '4 Case', 'Filters', 90),
  ('Carbon Filter (Activated Carbon)', '19x21x1', '4 Case', 'Filters', 100),
  ('Carbon Filter (Activated Carbon)', '24x24x1', '4 Case', 'Filters', 110),
  ('Shop Vac Filter', NULL, '2 Pack', 'Filters', 120),
  ('Filter for Hepa 500 Scrubber', '18x18x2.5', 'each', 'Filters', 130),
  ('Filter for Hepa 700 Scrubber', '19x21x4', 'each', 'Filters', 140),
  ('Filter for Hepa 2000 Scrubber', NULL, 'each', 'Filters', 150),
  ('Hepa Vacuum Bag (large Openning)', '10QT', '20 Case', 'Filters', 160),
  ('Hepa Vacuum Bag (large Openning)', '6QT', '20 Case', 'Filters', 170),
  ('Terry Cloth Rags', NULL, '25/50 LBS', 'General / Cleaning Supplies', 10),
  ('Micro fiber Rags', NULL, 'each', 'General / Cleaning Supplies', 20),
  ('Bio boxes and bags', NULL, 'each', 'General / Cleaning Supplies', 30),
  ('Ram Board', NULL, 'each', 'General / Cleaning Supplies', 40),
  ('Rosin paper', NULL, 'each', 'General / Cleaning Supplies', 50),
  ('Mop heads', NULL, 'each', 'General / Cleaning Supplies', 60),
  ('Lemon - General  cleaning', NULL, 'each', 'General / Cleaning Supplies', 70),
  ('Lavender- General  cleaning', NULL, 'each', 'General / Cleaning Supplies', 80),
  ('Dry Spongaes', '1 1/2" x 3" x 6"', 'each', 'General / Cleaning Supplies', 90),
  ('Trap', NULL, 'each', 'General / Cleaning Supplies', 100),
  ('Lock Box', NULL, 'each', 'General / Cleaning Supplies', 110),
  ('Pad Lock', NULL, 'each', 'General / Cleaning Supplies', 120),
  ('Nitrile Gloves 100 Box', 'Medium', '10 Case', 'Gloves / PPE', 10),
  ('Nitrile Gloves 100 Box', 'Large', '10 Case', 'Gloves / PPE', 20),
  ('Nitrile Gloves 100 Box', 'Extra Large', '10 Case', 'Gloves / PPE', 30),
  ('Nitrile Gloves - 18"', NULL, 'each', 'Gloves / PPE', 40),
  ('Palm Coated Gloves (Red)', 'Standard', '300 Case', 'Gloves / PPE', 50),
  ('3M Particulate Resp. N95 -20pk', 'Standard', '8 case', 'Gloves / PPE', 60),
  ('Shoe Covers', NULL, 'each', 'Gloves / PPE', 70),
  ('Tyvek Suit', NULL, 'each', 'Gloves / PPE', 80),
  ('Tyvek Suit - Yellow (for BIO)', NULL, 'each', 'Gloves / PPE', 90),
  ('Full Face Respirator', NULL, 'each', 'Gloves / PPE', 100),
  ('Respirator Cartridges', NULL, 'each', 'Gloves / PPE', 110),
  ('Breathable hooded cover all  (all sizes)', NULL, 'each', 'Gloves / PPE', 120),
  ('Respirator cartridges (light)', NULL, 'each', 'Gloves / PPE', 130),
  ('Respirator cartridges (3M 6001)', NULL, 'each', 'Gloves / PPE', 140),
  ('Respirator cartridges (heavy)', NULL, 'each', 'Gloves / PPE', 150)
ON CONFLICT DO NOTHING;