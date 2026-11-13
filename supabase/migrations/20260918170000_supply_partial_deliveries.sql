-- Deliveries that arrive short, and the remainder that is still coming.
--
-- David, 17 Sep, walking the supplies queue: "we should have a place where we
-- can put in exactly what was delivered — meaning if I ordered five rolls and
-- they only delivered four rolls, it's still gonna show as one is pending...
-- and then potentially they should let me know somehow that there's still
-- something pending."
--
-- Until now a delivery was all-or-nothing: pressing "Mark delivered" stocked
-- every line at the quantity ORDERED and closed the request. An order that
-- arrived four rolls short went into inventory as five and read as complete.

-- 1. What has actually arrived, per line ------------------------------------
-- The ordered quantity stays exactly where it is. This is a second number
-- beside it, because "how many did we ask for" and "how many turned up" are
-- different facts and the gap between them is the thing David wants to see.
ALTER TABLE public.supply_request_lines
  ADD COLUMN IF NOT EXISTS delivered_quantity numeric(10,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE public.supply_request_lines
    ADD CONSTRAINT supply_line_delivered_not_negative CHECK (delivered_quantity >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.supply_request_lines.delivered_quantity IS
  'How much of this line has actually arrived. Below quantity means a remainder is still pending.';

-- Existing DELIVERED requests are backfilled to "fully delivered", because
-- that is what the old all-or-nothing flow meant when it set that status.
-- Anything not delivered stays at zero. Without this every historical order
-- would suddenly read as entirely outstanding.
UPDATE public.supply_request_lines l
   SET delivered_quantity = l.quantity
  FROM public.supply_requests r
 WHERE r.id = l.request_id
   AND r.status = 'delivered'
   AND l.delivered_quantity = 0;

-- 2. A line may now be delivered more than once -----------------------------
-- The old index allowed exactly ONE delivery movement per request per item, to
-- stop a second press of "Mark delivered" stocking the shelf twice. Partial
-- deliveries break that assumption outright: four rolls today and one next
-- week are two movements against the same line, and both are correct.
--
-- The guard it provided is not lost, it moves somewhere better. The app now
-- records the running `delivered_quantity` above and stocks only the DELTA
-- between what it was and what the office just typed. Re-submitting the same
-- numbers moves zero, which is a stronger guarantee than the index gave: it
-- survives a correction downward as well as a repeated press.
DROP INDEX IF EXISTS public.supply_stock_moves_delivery_key;

-- RLS is untouched. supply_request_lines and supply_stock_moves keep every
-- policy they had, and a new column inherits all of them.
