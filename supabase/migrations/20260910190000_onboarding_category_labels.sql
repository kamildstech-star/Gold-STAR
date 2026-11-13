-- The six onboarding categories, as account labels.
--
-- Mark: "each of these need to be labels as well and the questions tied to
-- them", listing Management, Insurance Broker, Public Adjuster, Direct Owner,
-- Outside Referral and Other.
--
-- The categories already existed as a question catalogue, but which one applied
-- was only ever INFERRED, from account_type and what_they_do. That works until
-- it does not: an account typed as commercial that is really a broker got the
-- wrong questions and there was no way to say so.
--
-- As labels they can be put on an account by hand, and the popup that opens
-- when a deal is dropped into Active Clients asks that category's questions.
-- The label wins where one is present; the type inference stays as the
-- fallback for the accounts nobody has labelled.
--
-- The names must match ONBOARDING_LABEL_TITLE in src/lib/onboarding-questions.ts
-- exactly, because that is what ties a label back to its questions. Renaming one
-- in Admin quietly returns that account to type inference rather than breaking.
--
-- Sorted below 40, where the gift and legal labels start, so the category reads
-- first on a header.

INSERT INTO public.tags (name, color, scopes, sort_order)
SELECT v.name, v.color, ARRAY['account']::public.tag_scope[], v.sort_order
FROM (VALUES
  ('Management',       '#1B5FA8', 10),
  ('Insurance Broker', '#2E8B57', 11),
  ('Public Adjuster',  '#7A1FA2', 12),
  ('Direct Owner',     '#B8860B', 13),
  ('Outside Referral', '#0F766E', 14),
  ('Other',            '#4A5A70', 15)
) AS v(name, color, sort_order)
-- Never a duplicate: two labels of one name would make the lookup a coin toss,
-- and an office that already made their own keeps theirs.
WHERE NOT EXISTS (
  SELECT 1 FROM public.tags t WHERE lower(t.name) = lower(v.name)
);
