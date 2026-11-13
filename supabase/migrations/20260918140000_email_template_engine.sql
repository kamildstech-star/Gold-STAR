-- The email template engine: one place where every template lives.
--
-- 16 Sep meeting, point 26, and the decision taken since — stop waiting on
-- Chaim and build the engine now:
--
--   "A single place where all email templates live (receipt, estimate, vendor
--    order, etc.) · Each template: a subject + body with fill-in blanks
--    (customer name, amount...) · Staff can edit the wording themselves in
--    Admin."
--
-- NOTHING HERE SENDS ANYTHING, and nothing in the app does either. This gives
-- the five templates stable keys and default wording so the engine is ready
-- and waiting; actual sending stays blocked on the backend approval.
--
-- The table is not rebuilt. public.email_templates already exists with key,
-- name, category, subject, body, is_active and a unique index on
-- (key, location_id) — which is exactly the shape a keyed engine needs. Two
-- things are added: a column recording who last edited, and the five rows.

-- 1. Who last edited ---------------------------------------------------------
-- `updated_at` is already maintained by the email_templates_updated_at trigger;
-- what was missing is the name beside the timestamp. Staff editing each other's
-- wording need to know whose sentence they are about to rewrite.
--
-- RLS is untouched and stays the boundary. email_templates already has RLS
-- enabled with "templates readable" (SELECT to any authenticated user) and
-- "templates managed by admins" (ALL to admin/owner/dev). A new column inherits
-- both, so this widens nobody's access — which is the requirement.
ALTER TABLE public.email_templates
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.email_templates.updated_by IS
  'Who last saved this template. Set together with the updated_at trigger.';

-- 2. Adopt the receipt template that already exists --------------------------
-- 20260910010000 seeded 'payment_receipt_default' so the receipt button would
-- stop opening on a blank picker. That IS the engine's receipt template; it
-- just predates the idea of a stable key.
--
-- Renaming the key rather than inserting a second row matters for a reason that
-- migration spelled out itself: JobEmailDialog auto-selects the FIRST template
-- of a purpose, so "a second template with the same purpose would make the
-- auto-select a coin toss". Adopting also keeps any wording staff have already
-- edited into it, which inserting would strand.
UPDATE public.email_templates
   SET key = 'receipt'
 WHERE key = 'payment_receipt_default'
   AND location_id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.email_templates
      WHERE key = 'receipt' AND location_id IS NULL
   );

-- 3. The five templates ------------------------------------------------------
-- Wording is copied verbatim from EMAIL_TEMPLATE_DEFAULTS in
-- src/lib/email-templates.ts, and a test pins the two together so they cannot
-- drift. The app falls back to the same strings when a row is missing, so a
-- database that has not had this migration still composes correctly.
--
-- ON CONFLICT DO NOTHING against email_templates_key_location_uniq: re-running
-- is safe, and an office that has already written their own wording under one
-- of these keys keeps it. Nothing here overwrites an edit, ever.
--
-- Categories reuse the existing email_category enum — payment_receipt,
-- estimate, invoice, notification — so no enum value is added and this needs no
-- second transaction.
INSERT INTO public.email_templates (key, name, category, subject, body, is_active)
VALUES
  (
    'receipt',
    'Payment receipt',
    'payment_receipt',
    'Payment received — thank you (invoice {{invoice_number}})',
    concat_ws(E'\n',
      '<p>Dear {{customer_name}},</p>',
      '<p>Thank you. We have received your payment of <b>{{amount}}</b> on {{payment_date}} by {{payment_method}}, applied to invoice {{invoice_number}} for the work at {{job_address}}.</p>',
      '<p>Invoice total: {{invoice_total}}<br/>Balance remaining: {{balance_remaining}}</p>',
      '<p>Please keep this receipt for your records. If anything above does not look right, call us and we will straighten it out.</p>',
      '<p>{{company_name}}<br/>{{company_phone}}</p>'
    ),
    true
  ),
  (
    'estimate_send',
    'Estimate',
    'estimate',
    'Your estimate from {{company_name}} — {{job_address}}',
    concat_ws(E'\n',
      '<p>Dear {{customer_name}},</p>',
      '<p>Thank you for allowing us to look at the {{loss_type}} damage at {{job_address}}. Our estimate {{estimate_number}} for that work comes to <b>{{amount}}</b>.</p>',
      '<p>You can review the full estimate here: {{estimate_link}}</p>',
      '<p>This estimate is good through {{valid_until}}. If anything in it needs adjusting, or you would like us to walk you through the line items, call us and we will go through it together.</p>',
      '<p>{{company_name}}<br/>{{company_phone}}</p>'
    ),
    true
  ),
  (
    'invoice_send',
    'Invoice',
    'invoice',
    'Invoice {{invoice_number}} from {{company_name}}',
    concat_ws(E'\n',
      '<p>Dear {{customer_name}},</p>',
      '<p>Please find invoice {{invoice_number}} for the work completed at {{job_address}}. The total is <b>{{amount}}</b>, with {{balance_remaining}} due by {{due_date}}.</p>',
      '<p>You can pay online here: {{payment_link}}</p>',
      '<p>If you have any questions about this invoice, please call us before the due date and we will be glad to go over it.</p>',
      '<p>{{company_name}}<br/>{{company_phone}}</p>'
    ),
    true
  ),
  (
    'vendor_order',
    'Vendor order',
    'notification',
    'Purchase order {{order_number}} from {{company_name}}',
    concat_ws(E'\n',
      '<p>Hello {{vendor_name}},</p>',
      '<p>Please supply the following against purchase order {{order_number}}:</p>',
      '<p>{{order_lines}}</p>',
      '<p>Needed by: {{needed_by}}<br/>Deliver to: {{delivery_address}}</p>',
      '<p>Please confirm receipt of this order and let us know if anything is back-ordered. Questions to {{requested_by}} on {{company_phone}}.</p>',
      '<p>Thank you,<br/>{{company_name}}</p>'
    ),
    true
  ),
  (
    'intake_confirmation',
    'Job confirmation',
    'notification',
    'We are on the way — job {{job_number}} at {{job_address}}',
    concat_ws(E'\n',
      '<p>Dear {{customer_name}},</p>',
      '<p>Thank you for calling {{company_name}}. We have your {{loss_type}} loss at {{job_address}} on our schedule as job {{job_number}}.</p>',
      '<p>{{technician_name}} is scheduled to arrive on {{scheduled_date}}. If anything changes on your end, or the damage gets worse before we arrive, call us right away on {{company_phone}} — do not wait.</p>',
      '<p>In the meantime, please keep everyone clear of the affected area and do not run any equipment that got wet.</p>',
      '<p>{{company_name}}<br/>{{company_phone}}</p>'
    ),
    true
  )
ON CONFLICT DO NOTHING;
