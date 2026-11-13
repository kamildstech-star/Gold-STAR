-- T5 (27 Oct 2026): US English for display labels seeded into the database.
-- Keys ('cancelled', 'state_contractor_licence') are data and stay as they
-- are; only the labels a person reads change, and only where an admin has not
-- already renamed them.

UPDATE public.pipeline_stages
   SET name = 'Canceled'
 WHERE key = 'cancelled' AND name = 'Cancelled';

UPDATE public.option_list_values
   SET label = 'Canceled'
 WHERE key = 'cancelled' AND label = 'Cancelled';

UPDATE public.option_list_values
   SET label = 'State Contractor License'
 WHERE key = 'state_contractor_licence' AND label = 'State Contractor Licence';
