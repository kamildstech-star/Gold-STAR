-- Gold Star's real supply catalogue, from David's spreadsheet.
--
-- Meeting point 18, 16 Sep: the supply order form was rebuilt so its sections
-- are the catalogue's own categories rather than a list in the code, and it has
-- been waiting for David's sheet ever since. The sheet arrived on 18 Sep — 84
-- items across six categories — so this replaces the six clearly-marked example
-- rows that 20260918091000 seeded for testing with the items his crews
-- actually order.
--
-- THE SHEET HAS FOUR COLUMNS AND NO OTHERS: category, description, size,
-- case_qty. There is no SKU, no supplier and no price in it, and none is
-- invented here — those columns stay empty. A supplier and a price are facts
-- about a PURCHASE, not about an item, and the purchaser side built in meeting
-- point 20 already records both per receipt.
--
-- The mapping is one line each, and lives in code too, in
-- `catalogueRowFromSheet` (src/lib/supply-spend.ts), which a test pins against
-- this file and against docs/gsr-supplies-import.csv so the three cannot drift:
--
--   category    -> category    (whitespace collapsed; see below)
--   description -> name
--   size        -> size        (NEW column, verbatim)
--   case_qty    -> unit        (verbatim)
--
-- `case_qty` becomes `unit` because it is the unit somebody orders in: nobody
-- asks for one strip of duct tape, they ask for a 24 Case. Both it and `size`
-- are stored exactly as David typed them — "12 case" and "12 Case" both
-- survive, because his sheet is the record of what he buys and normalising his
-- capitalisation would invent structure he did not ask for. The ONE exception
-- is category, where "General  / Cleaning Supplies" is collapsed to a single
-- space: it is a heading in the order form and the double gap renders.

-- 1. Size is its own column ------------------------------------------------
-- Not folded into the name. The sheet repeats a description across sizes —
-- five Pleated Filter Merv 8 rows, four Carbon Filter rows, three sizes of
-- Nitrile Gloves — and each size is separately orderable, which is exactly what
-- David asked for. Folding "21x19x2" into the name would make the name a
-- compound key and leave nothing to show the person ordering.
ALTER TABLE public.supply_items
  ADD COLUMN IF NOT EXISTS size text;

COMMENT ON COLUMN public.supply_items.size IS
  'Size exactly as the client''s sheet types it: 2"x60 Yard, 21x19x2, 10QT. Display only — never parsed.';

-- 2. A name is unique PER SIZE ----------------------------------------------
-- supply_items_name_key was unique on lower(name) alone, which would reject
-- four of the five Pleated Filter rows. The rule David described is that each
-- size is its own orderable row, so that is the rule the index now enforces.
-- It agrees with `catalogueImportKey` in src/lib/supply-spend.ts, deliberately:
-- an import that accepts rows the database then rejects fails halfway through.
DROP INDEX IF EXISTS public.supply_items_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS supply_items_name_size_key
  ON public.supply_items (lower(name), lower(coalesce(size, '')));

-- 3. The example rows go ----------------------------------------------------
-- 20260918091000 seeded six rows so the rebuilt form could be tested before a
-- real catalogue existed. They were marked twice for exactly this moment.
--
-- Anything that referenced one keeps its words first. A request line and a
-- purchase each carry a CHECK that they must name SOMETHING, and the foreign
-- keys are ON DELETE SET NULL, so deleting the item out from under a line that
-- has no free text of its own would fail the check. The item's name is copied
-- into the free-text column first, so an old test request still reads as what
-- was asked for instead of blocking the delete.
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

-- 4. David's 84 items -------------------------------------------------------
-- sort_order counts up in tens within each category, preserving the order of
-- his sheet — the order form sorts on it, so the sections read the way he reads
-- them rather than alphabetically.
--
-- ON CONFLICT DO NOTHING so re-running this is safe, and so an item somebody
-- has already typed into the Catalog screen by hand is left alone rather than
-- failing the whole load.
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
