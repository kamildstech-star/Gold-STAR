-- Remove the "Other" onboarding category, tag and questions.
--
-- Mark: "remove the other tab and the questions associated with it" -- "tag".
--
-- "Other" was the catch-all: the label the type inference fell back to when an
-- account matched none of the five real categories, and a question set asking
-- what the company is in plain words, whether they send or receive work, what
-- paperwork they need and a follow-up cadence.
--
-- Removing the catch-all changes what happens to an account that matches
-- nothing. It used to be handed a guessed category and its questions. It now
-- gets NO category, and the win popup asks only for the green light date. That
-- is the honest answer -- putting a guessed company type in front of somebody
-- and creating tasks from their replies is worse than asking nothing.
--
-- Safe to delete outright: checked first, the tag was on 0 accounts and 0
-- contacts, so nothing is being taken off a record. The delete is written to
-- act only on an unused row, so re-running it on a database where somebody HAS
-- since applied it leaves that row alone rather than orphaning their work.

DELETE FROM public.tags t
 WHERE lower(t.name) = 'other'
   AND t.scopes @> ARRAY['account']::public.tag_scope[]
   AND NOT EXISTS (SELECT 1 FROM public.account_tags a WHERE a.tag_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM public.contact_tags c WHERE c.tag_id = t.id);
