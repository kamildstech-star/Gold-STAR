-- Shared office mailboxes get an owner: whose Microsoft sign-in reads them.
--
-- WRITTEN, NOT APPLIED. One nullable column on graph_mailboxes and an index.
-- No policy, grant or function changes; no existing row changes. The app
-- works before this is applied: every read of the column falls back to the
-- older shape, and a shared mailbox simply reads as "needs an owner".
--
-- Why: with delegated access (IT's ask; Option A of
-- docs/OUTLOOK-ACCESS-PROPOSAL.md, connections from 20261007200000) there is
-- no company credential to read an office mailbox with. A person IT has given
-- Full Access to connects Outlook with the shared-mailbox scopes, and an
-- admin records them here as the mailbox's owner; sync, subscriptions and
-- calendar pushes for that mailbox then use their token
-- (src/lib/graph-auth.server.ts). If they disconnect, need to reconnect, or
-- are deactivated, the mailbox pauses and shows "needs an owner" — nobody
-- else's token is borrowed.
--
-- Personal mailboxes ignore this column: they are always read with their own
-- person's token (graph_mailboxes.user_id).
--
-- Writes go through the existing "graph mailboxes managed by admins" policy
-- (owner/admin/dev) and the setGraphMailboxOwner server function; reads
-- through the existing "graph mailboxes viewable by staff" policy. Removing
-- the person's profile clears the owner (ON DELETE SET NULL).
--
-- Re-runnable: IF NOT EXISTS.

ALTER TABLE public.graph_mailboxes
  ADD COLUMN IF NOT EXISTS owner_user_id uuid
    REFERENCES public.profiles(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS graph_mailboxes_owner_user_idx
  ON public.graph_mailboxes (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

COMMENT ON COLUMN public.graph_mailboxes.owner_user_id IS
  'Delegated mode: the person whose Microsoft sign-in (with the .Shared scopes) reads this shared office mailbox. Ignored for personal mailboxes.';
