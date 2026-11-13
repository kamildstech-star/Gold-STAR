-- Gold Star's T&M rate codes, as a catalogue the office can edit.
--
-- WRITTEN, NOT APPLIED. One new table, seeded. Nothing existing changes. The
-- app works before this is applied: src/lib/tm-rate-codes.ts answers with the
-- same list compiled into it when the table is missing.
--
-- Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
-- pages that are used for each day." The rate codes are the ones printed on
-- Gold Star's Daily Supply List 1.1 — Labor Rates (APM, BMT, CA, … WE3),
-- General Consumables (100–156), Equipment (300–346), Personal Protective
-- Equipment (200–212), Vehicular Charges (400–406) and General Charges — and
-- the same codes T&M Pro, where the office bills T&M jobs, uses for its Labor
-- Class and line items. The seed below is that sheet line for line (extracted
-- from the PDF, two identical "8500-15000 CFM" desiccant lines included, as
-- printed under 317 and 318).
--
-- No prices. The sheet has none and T&M Pro holds the rates; a second price
-- list here would only be a second place for a rate to be wrong.
--
-- General Charges carry no code on the paper (Quantity only). Their codes
-- here, GEN-…, are storage keys for the filled sheet; the app never prints
-- them as a code.
--
-- Editing: the Supply catalog's rule (supply_items_read / supply_items_manage)
-- as job_task_templates has it (20261006174500) — every signed-in staff member
-- reads, only is_privileged (owner / admin / dev) inserts and updates, nobody
-- deletes. A code already written on a filled sheet must keep meaning
-- something, so a code is switched off (active = false), never removed, and
-- the code itself cannot be changed by an edit (the trigger pins it).
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS /
-- ON CONFLICT DO NOTHING (an admin's later relabel is never overwritten).

CREATE TABLE IF NOT EXISTS public.tm_rate_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  label text NOT NULL CHECK (length(btrim(label)) > 0),
  section text NOT NULL CHECK (section IN (
    'labor', 'consumable', 'equipment', 'ppe', 'vehicle', 'general')),
  unit_note text,
  sort_order integer NOT NULL DEFAULT 1000,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid DEFAULT auth.uid()
);
CREATE INDEX IF NOT EXISTS tm_rate_codes_section_order_idx
  ON public.tm_rate_codes (section, sort_order);

CREATE OR REPLACE FUNCTION public.tg_tm_rate_codes_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  -- The code is what a filled sheet stores; renaming it would orphan them.
  NEW.code := OLD.code;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_tm_rate_codes_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS tm_rate_codes_touch ON public.tm_rate_codes;
CREATE TRIGGER tm_rate_codes_touch BEFORE UPDATE ON public.tm_rate_codes
  FOR EACH ROW EXECUTE FUNCTION public.tg_tm_rate_codes_touch();

-- Daily Supply List 1.1, section by section in the sheet's order. Held equal
-- to TM_RATE_CODES_COMPILED by src/lib/tm-rate-codes.test.ts.
INSERT INTO public.tm_rate_codes (code, section, label, sort_order) VALUES
  ('APM', 'labor', 'Assistant Project Manager', 10),
  ('BMT', 'labor', 'Biohazard / Mold Technician', 20),
  ('CA', 'labor', 'Carpenter', 30),
  ('CE', 'labor', 'Clerical Administrator / Accountant', 40),
  ('CC', 'labor', 'Content Coordinator', 50),
  ('CM', 'labor', 'Content Manipulation', 60),
  ('CCF', 'labor', 'Crew Chief', 70),
  ('DL', 'labor', 'Demolition Labor', 80),
  ('DI', 'labor', 'Drywall Installer', 90),
  ('GL', 'labor', 'General Labor', 100),
  ('HSO', 'labor', 'Health & Safety Officer', 110),
  ('MT', 'labor', 'Monitoring Technician', 120),
  ('PNT', 'labor', 'Painter', 130),
  ('PCT', 'labor', 'Project Consultant', 140),
  ('PCR', 'labor', 'Project Coordinator', 150),
  ('PE', 'labor', 'Project Estimator', 160),
  ('PF', 'labor', 'Project Foreman', 170),
  ('PM', 'labor', 'Project Manager', 180),
  ('PS', 'labor', 'Project Supervisor', 190),
  ('RS', 'labor', 'Remediation Supervisor', 200),
  ('RT', 'labor', 'Remediation Technician', 210),
  ('SL', 'labor', 'Skilled Labor', 220),
  ('SPM', 'labor', 'Sr. Project Manager', 230),
  ('SCL', 'labor', 'Structural Cleaning Labor', 240),
  ('TL', 'labor', 'Temporary Labor - Board up', 250),
  ('WE', 'labor', 'Water Extraction', 260),
  ('WE3', 'labor', 'Water Extraction - Cat 3', 270),
  ('100', 'consumable', 'Anti-microbial agent', 10),
  ('101', 'consumable', 'Anti-freeze', 20),
  ('102', 'consumable', '2" x 2" x 8''', 30),
  ('103', 'consumable', '4 Mil Poly (for containment and protection) Billed per roll', 40),
  ('104', 'consumable', '6 Mil Poly (for containment and protection) Billed per roll', 50),
  ('105', 'consumable', 'Hardboard Panel', 60),
  ('106', 'consumable', 'HEPA filter (for HEPA vac)', 70),
  ('107', 'consumable', 'HEPA filter (for neg. air machine/vacuum - Large)', 80),
  ('108', 'consumable', 'HEPA filter (for negative air exhaust fan)', 90),
  ('109', 'consumable', 'Board-up Door - Security Door with Hinges', 100),
  ('110', 'consumable', 'Board-ups - per board', 110),
  ('111', 'consumable', 'Box - extra large size', 120),
  ('112', 'consumable', 'Box - large size', 130),
  ('113', 'consumable', 'Box - medium size', 140),
  ('114', 'consumable', 'Box - small size', 150),
  ('115', 'consumable', 'Broom set', 160),
  ('116', 'consumable', 'Bubble Wrap 12" Roll', 170),
  ('117', 'consumable', 'Carbon vapor filter (for air scrubber) - 16" x 16"', 180),
  ('118', 'consumable', 'Carbon vapor filter (for air scrubber) - 24" x 24"', 190),
  ('119', 'consumable', 'Ceiling Tile 2'' x 2''', 200),
  ('120', 'consumable', 'Ceiling Tile 2'' x 4''', 210),
  ('121', 'consumable', 'Chemical gas and odor neutralization cartridge - 16" x 16"', 220),
  ('122', 'consumable', 'Cleaning Rags - Per box of 100', 230),
  ('123', 'consumable', 'Dish pack box, packing paper & tape', 240),
  ('124', 'consumable', 'Dry Ice Pellets - for blasting (50 LB)', 250),
  ('125', 'consumable', 'Dry Sponge (per box)', 260),
  ('126', 'consumable', 'Encapsulant - per gal', 270),
  ('127', 'consumable', 'Floor cleaner (gallon)', 280),
  ('128', 'consumable', 'Generator DEF charge', 290),
  ('129', 'consumable', 'Glass Cleaner', 300),
  ('130', 'consumable', 'Industrial grade mop heads (each)', 310),
  ('131', 'consumable', 'Lavender Cleaner (or equivalent)', 320),
  ('132', 'consumable', 'Lay-flat Ducting (for Negative air/Air scrubbers)', 330),
  ('133', 'consumable', 'Mold Stain Remover', 340),
  ('134', 'consumable', 'Mop bucket W/Ringer', 350),
  ('135', 'consumable', 'Mop stick', 360),
  ('136', 'consumable', 'Moving Blanket', 370),
  ('137', 'consumable', 'Padlock and hasp', 380),
  ('138', 'consumable', 'Paint Bucket/Tray', 390),
  ('139', 'consumable', 'Paint Roller', 400),
  ('140', 'consumable', 'Paint Roller Cover', 410),
  ('141', 'consumable', 'Peel & seal zipper', 420),
  ('142', 'consumable', 'Plastic contractor trash bag (per box of 50)', 430),
  ('143', 'consumable', 'Ram Board - billed per roll', 440),
  ('144', 'consumable', 'Shovels', 450),
  ('145', 'consumable', 'Smoke Seal - gal', 460),
  ('146', 'consumable', 'Super 77 Spray Adhesive 13.8oz', 470),
  ('147', 'consumable', 'Tape, Caution 3" x 1000''', 480),
  ('148', 'consumable', 'Tape, Duct - 2" x 60 yds.', 490),
  ('149', 'consumable', 'Tape, HVAC 2" x 50 yds.', 500),
  ('150', 'consumable', 'Tape, Painter (Blue) 2" x 60 yards.', 510),
  ('151', 'consumable', 'Tape, Poly/Box - 2" x 109 yds.', 520),
  ('152', 'consumable', 'Tarp Roof - SQ FT', 530),
  ('153', 'consumable', 'UnSmoke Degreaser - per gal', 540),
  ('154', 'consumable', 'Wardrobe box & tape - large size', 550),
  ('155', 'consumable', 'Wardrobe box & tape - medium size', 560),
  ('156', 'consumable', 'Wardrobe box & tape - small size', 570),
  ('300', 'equipment', '2" submersible trash pump and hose - per hr', 10),
  ('301', 'equipment', 'Add on kit for drying', 20),
  ('302', 'equipment', 'Air mover - No monitoring', 30),
  ('303', 'equipment', 'Air mover axial fan (per 24 hour period) - No monitoring', 40),
  ('304', 'equipment', 'Air Scrubber - 2000 CFM w/o filter - No monitoring', 50),
  ('305', 'equipment', 'Air Scrubber - HEPA 500 w/o filter - No monitoring', 60),
  ('306', 'equipment', 'Air Scrubber - HEPA 700 w/o filter - No monitoring', 70),
  ('307', 'equipment', 'Airless Sprayer', 80),
  ('308', 'equipment', 'Axial fan air mover - 1 HP - No monitoring', 90),
  ('309', 'equipment', 'Carpet Extractor', 100),
  ('310', 'equipment', 'Containment Barrier Tension Post - each', 110),
  ('311', 'equipment', 'Dehumidifier - 110-159 ppd - No monitoring', 120),
  ('312', 'equipment', 'Dehumidifier - 160+ ppd - No monitoring', 130),
  ('313', 'equipment', 'Dehumidifier - 70-109 ppd - No monitoring', 140),
  ('314', 'equipment', 'Dehumidifier - Desiccant - No monitoring', 150),
  ('315', 'equipment', 'Dehumidifier - Desiccant - 3000-4000 CFM - No monitoring', 160),
  ('316', 'equipment', 'Dehumidifier - Desiccant - 4500-7500 CFM - No monitoring', 170),
  ('317', 'equipment', 'Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring', 180),
  ('318', 'equipment', 'Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring', 190),
  ('319', 'equipment', 'Dehumidifier - Large - Desiccant - No monitoring', 200),
  ('320', 'equipment', 'Dehumidifier - up to 69 ppd - No monitoring', 210),
  ('321', 'equipment', 'Deodorize building - Ozone treatment', 220),
  ('322', 'equipment', 'Disinfecting/sanitizing fogging or spray machine', 230),
  ('323', 'equipment', 'Drying - Injector', 240),
  ('324', 'equipment', 'Floor Drying Mats', 250),
  ('325', 'equipment', 'Generator - Up to 3,000 watt - portable', 260),
  ('326', 'equipment', 'Generator - 3,001 - 6,000 watt - portable', 270),
  ('327', 'equipment', 'Generator temporary power cable', 280),
  ('328', 'equipment', 'Generator temporary power cable ramp', 290),
  ('329', 'equipment', 'HEPA Vacuum (back pack, cannister, or upright)', 300),
  ('330', 'equipment', 'Hot thermal fogging machine', 310),
  ('331', 'equipment', 'Hydroxyl Generator - Odor Counteractant', 320),
  ('332', 'equipment', 'Ice Blasting Machine', 330),
  ('333', 'equipment', 'Injection Drying', 340),
  ('334', 'equipment', 'Multi-phase oxidizer (ozone, hydroxyls, etc.) generator', 350),
  ('335', 'equipment', 'Ozone machine', 360),
  ('336', 'equipment', 'Pallet Jack', 370),
  ('337', 'equipment', 'Pickup and Delivery charge (per piece of heavy equipment)', 380),
  ('338', 'equipment', 'Power distribution box - 100+ amp', 390),
  ('339', 'equipment', 'Power distribution box - below 100 amp', 400),
  ('340', 'equipment', 'Pressure washing machine', 410),
  ('341', 'equipment', 'Scaffold - per section', 420),
  ('342', 'equipment', 'Shop Vac', 430),
  ('343', 'equipment', 'Temporary Lighting - 100'' per string', 440),
  ('344', 'equipment', 'Temporary Lighting - 50'' per string', 450),
  ('345', 'equipment', 'Truck Mount Extractor', 460),
  ('346', 'equipment', 'Water Extractor', 470),
  ('200', 'ppe', 'Face Mask - disposable (per pair)', 10),
  ('201', 'ppe', 'Face Shield - Full Face', 20),
  ('202', 'ppe', 'Face Shield - Half Face', 30),
  ('203', 'ppe', 'Fall protection harness and lanyard (per day)', 40),
  ('204', 'ppe', 'Hard Hat', 50),
  ('205', 'ppe', 'Nitrile Gloves-per box', 60),
  ('206', 'ppe', 'Personal Protective Equipment - Tyvek', 70),
  ('207', 'ppe', 'Personal Protective Gloves (Disposable - per pair)', 80),
  ('208', 'ppe', 'Personal Protective Gloves (per pair)', 90),
  ('209', 'ppe', 'Protective Boots (per pair)', 100),
  ('210', 'ppe', 'Respirator - Half Face', 110),
  ('211', 'ppe', 'Respirator Cartridges', 120),
  ('212', 'ppe', 'Safety Glasses', 130),
  ('400', 'vehicle', 'Box Truck', 10),
  ('401', 'vehicle', 'Cargo Van', 20),
  ('402', 'vehicle', 'Fuel surcharge for box truck', 30),
  ('403', 'vehicle', 'Fuel surcharge for vehicles', 40),
  ('404', 'vehicle', 'Passenger Van', 50),
  ('405', 'vehicle', 'Personal Company Vehicle', 60),
  ('406', 'vehicle', 'Pickup Truck', 70),
  ('GEN-ESF', 'general', 'Emergency Service Fee', 10),
  ('GEN-DEBRIS', 'general', 'Debris Removal - Pass Through plus 20%', 20),
  ('GEN-HOTEL', 'general', 'Hotel - Pass Through plus 20%', 30),
  ('GEN-OP', 'general', 'O & P - 20% of 3rd party bills', 40),
  ('GEN-PERDIEM', 'general', 'Per Diem - Per Person', 50),
  ('GEN-SMALLTOOLS', 'general', 'Small Tools Charge - 3% of billed labor', 60)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------
-- Supabase grants every new public table to the client roles by default; the
-- catalogue is read and edited, never deleted, so start from nothing.
REVOKE ALL ON public.tm_rate_codes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.tm_rate_codes TO authenticated;
GRANT ALL ON public.tm_rate_codes TO service_role;
ALTER TABLE public.tm_rate_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tm_rate_codes_read ON public.tm_rate_codes;
CREATE POLICY tm_rate_codes_read ON public.tm_rate_codes
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS tm_rate_codes_insert ON public.tm_rate_codes;
CREATE POLICY tm_rate_codes_insert ON public.tm_rate_codes
  FOR INSERT TO authenticated
  WITH CHECK (public.is_privileged((SELECT auth.uid())));
DROP POLICY IF EXISTS tm_rate_codes_update ON public.tm_rate_codes;
CREATE POLICY tm_rate_codes_update ON public.tm_rate_codes
  FOR UPDATE TO authenticated
  USING (public.is_privileged((SELECT auth.uid())))
  WITH CHECK (public.is_privileged((SELECT auth.uid())));

-- The convention 20260929121000 applies to every RLS table.
DROP POLICY IF EXISTS active_profile_required ON public.tm_rate_codes;
CREATE POLICY active_profile_required ON public.tm_rate_codes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.tm_rate_codes;
CREATE POLICY anonymous_business_access_denied ON public.tm_rate_codes
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.tm_rate_codes;
    CREATE POLICY portal_customer_denied ON public.tm_rate_codes
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
