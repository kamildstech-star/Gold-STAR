-- Proposals on a pipeline card: create, send for e-signature, and the card
-- moves itself.
--
-- WRITTEN, NOT APPLIED. Two new tables, one new stage on each of the two
-- account pipelines, three trigger functions, two access helpers, and one
-- function replaced (sales_rep_metrics, one expression). Nothing is dropped.
-- Until this is applied the app says proposals are not available yet
-- (src/lib/account-proposals.ts treats a missing table as "not yet") and
-- nothing else changes.
--
-- Mark: "Is there a way to make something in the pipeline a proposal?" — and
-- then the full flow, for the Prospecting and Relationship pipelines (account
-- pipelines, not Jobs).
--
-- ============================================================================
-- WHAT A PROPOSAL IS
-- ============================================================================
--
--   public.account_proposals       one per proposal: the account, a title, the
--                                  contract template (and the exact version)
--                                  it is printed from, subtotal/total, notes,
--                                  terms, and the status lifecycle
--                                      draft -> sent -> signed | declined | expired
--   public.account_proposal_lines  the priced lines: description, quantity,
--                                  unit price, and line_total, which is a
--                                  GENERATED column (quantity x unit price,
--                                  rounded to the cent) so no client can send
--                                  a line total that is not the product.
--
-- subtotal is always the sum of the lines, recomputed by the guard trigger on
-- every write to the proposal (a line write touches its proposal to make that
-- happen); whatever a client sends for subtotal/total is ignored. total equals
-- subtotal today — there is no tax or discount on a proposal yet — and is kept
-- as its own column so adding one later is not a reshape.
--
-- E-SIGNATURE IS THE EXISTING PATH, NOT A SECOND ONE. "Send for e-signature"
-- writes an ordinary `documents` row from the chosen template (the same insert
-- the Documents panel's "Send for signature" makes), sends it through the same
-- `document_send_packets` link and /sign/$token page, and stores that
-- document's id here. When the customer signs, complete_document_signing_atomic
-- (20260908014000) sets documents.status = 'signed' exactly as it does today;
-- the trigger below on `documents` sees that and marks the proposal signed.
-- There is no webhook of our own and no provider call. (ESIGN_PROVIDER in the
-- integration catalogue names a future vendor; nothing reads it.)
--
-- ============================================================================
-- THE STAGE AUTOMATION, AND WHY IT IS A PLAIN UPDATE OF accounts.stage_id
-- ============================================================================
--
-- A drag on /pipeline is `UPDATE accounts SET stage_id = ...` as the rep, and
-- everything else hangs off that write: trg_accounts_stage_normalize,
-- trg_accounts_stage_history (account_stage_history, with changed_by =
-- auth.uid()), trg_automation_accounts / trg_automation_stage_history
-- (tg_automation_notify), trg_accounts_stage_rules_reset and the rest. A drop
-- on Active Clients is pipeline_activate_client(), which is that same UPDATE
-- plus the lifecycle columns. The automation here does exactly those two
-- writes and nothing cleverer, so every trigger fires as it does for a hand
-- move, and then stamps the reason onto the history row the trigger wrote —
-- the same thing stage_advance_evaluate (20260909120100) does for its moves.
--
--   sent      -> the pipeline's `proposal_sent` stage, ONLY if the account is
--                at an earlier stage (lower sort_order, not won, not lost).
--                Never backwards: a card already at Active Client, No Service
--                Needed or GOASTED stays where it is.
--   signed    -> the pipeline's won stage through pipeline_activate_client
--                (Prospecting: Active Client; Relationship: Active), with the
--                signing date as the green-light date — the drop on Active
--                Clients, minus the onboarding questions, which the rep is
--                notified to finish. A pipeline with no won stage gets the
--                next stage after Proposal sent instead. Same never-backwards
--                rule.
--   declined  -> the stage is left alone; the decline is on the proposal and
--                on the account timeline.
--   expired   -> nothing moves.
--
-- What happened is written to account_proposals.stage_note ("Moved to Proposal
-- sent." / "Not moved: already at Active Client."), so the record can say it.
-- A move that fails never fails the status change, and above all never fails
-- a customer's signature: it is caught and written to stage_note instead.
--
-- When the move is driven by a signature there is no signed-in user, so the
-- history row the trigger writes has changed_by = NULL. It is stamped with the
-- rep who sent the proposal — their proposal closed the deal, and
-- sales_rep_metrics.accounts_closed counts won moves by changed_by. A hand
-- "Mark signed" keeps the rep who pressed it, as a drag would.
--
-- ============================================================================
-- THE NEW STAGE
-- ============================================================================
--
-- "Proposal sent", key `proposal_sent`, inserted right after Conversation
-- Established on Prospecting (before Active Client) and right after Meeting
-- held on the Relationship pipeline (before Vendor onboarding). Every later
-- stage shifts down 10 in sort_order, measured from the LIVE anchor stage, so
-- an order an admin has changed is kept. Orange (#EA580C): the app draws stages
-- by key (src/lib/stage-tone.ts), and `proposal_sent` falls to the orange tone
-- of the custom-stage set, so the admin colour matches what the board shows.
-- Probability sits between its neighbours (Prospecting 65 -> 80 -> 100,
-- Relationship 50 -> 60 -> 70). The Relationship pipeline is inactive today
-- (20260806170640); the stage is added anyway so it is there if it returns.
--
-- Note for the outreach rules: the ghost clock runs only in Active Outreach and
-- Conversation Established (RULE_STAGE_KEYS), so a card waiting in Proposal
-- sent is not ghosted by the 30-day sweep. That is deliberate — the proposal's
-- own status is what is outstanding — and it is a one-line change in
-- pipeline-rules if Mark wants the clock there too.
--
-- ============================================================================
-- ACCESS
-- ============================================================================
--
-- A proposal carries prices, so it is scoped like the account's documents and
-- the office-scoped half of accounts_select, NOT the company-wide
-- accounts_select_all_offices read (20260911120000):
--
--   read    can_view_location(uid, account.location_id) OR account.assigned_rep
--           = uid OR proposal.created_by = uid
--   write   can_manage_location(uid, account.location_id) OR
--           account.assigned_rep = uid — exactly the accounts_update policy,
--           because whoever may write a proposal may move its card, and the
--           automation moves it.
--   delete  drafts only, by the same people. A sent proposal is a record (it
--           counts in "Proposals sent").
--   lines   follow their proposal: readable when it is, writable only while it
--           is a draft and by its writers.
--
-- Both helpers are SECURITY DEFINER with search_path '' because they read
-- `accounts` to answer, as can_view_job does. The three trigger functions run
-- with the owner's rights for the bookkeeping (history reason, notification,
-- stage_note); the status change that wakes them has already passed the
-- caller's RLS, and the advance trigger checks the caller's right to the
-- account again before it moves anything. No grants to anon. The standard
-- restrictive active_profile_required / anonymous_business_access_denied /
-- portal_customer_denied policies are on both tables. Neither table is in
-- record_history, like the T&M forms: the account timeline and the signed
-- document are the record.
--
-- ============================================================================
-- REPORTS
-- ============================================================================
--
-- sales_rep_metrics.proposals_sent counted job `quotes` only. It now adds the
-- account proposals that rep SENT in the window (sent_by, sent_at). The body is
-- the one in 20260813072103 — the newest definition in this repo — with only
-- that expression changed; grants restated as they were. director_rep_kpis
-- (20260813073423) reads it and needs nothing.
--
-- Re-runnable: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS, and the
-- stage insert is skipped (and its sort_order shift with it) on a pipeline that
-- already has a `proposal_sent` stage.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- The account's pipeline when the proposal was written, for reporting. The
  -- automation always uses the pipeline the account is on when it fires.
  pipeline_id uuid REFERENCES public.pipelines(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  -- The contract template it prints from, and the exact version, as
  -- documents.template_id / template_version_id record them.
  template_id uuid REFERENCES public.document_templates(id) ON DELETE SET NULL,
  template_version_id uuid REFERENCES public.document_template_versions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'signed', 'declined', 'expired')),
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  total numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 10000),
  terms text CHECK (terms IS NULL OR char_length(terms) <= 20000),
  -- The document that went out for signature. SET NULL, never CASCADE.
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  sent_at timestamptz,
  sent_by uuid,
  signed_at timestamptz,
  declined_at timestamptz,
  declined_reason text CHECK (declined_reason IS NULL OR char_length(declined_reason) <= 2000),
  expired_at timestamptz,
  -- What the stage automation did the last time the status changed.
  stage_note text,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_proposals_account_idx
  ON public.account_proposals (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_proposals_document_idx
  ON public.account_proposals (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_proposals_sent_idx
  ON public.account_proposals (sent_by, sent_at) WHERE sent_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.account_proposal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.account_proposals(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  description text NOT NULL CHECK (char_length(btrim(description)) BETWEEN 1 AND 2000),
  quantity numeric(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  line_total numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_proposal_lines_proposal_idx
  ON public.account_proposal_lines (proposal_id, position);

-- ---------------------------------------------------------------------------
-- 2. Access helpers
-- ---------------------------------------------------------------------------
-- Who may read an account's proposals: its office (can_view_location covers
-- privileged roles, members and regions) or its rep.
CREATE OR REPLACE FUNCTION public.can_view_account_proposals(_user_id uuid, _account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.id = _account_id
       AND (public.can_view_location(_user_id, a.location_id) OR a.assigned_rep = _user_id)
  );
$$;
REVOKE ALL ON FUNCTION public.can_view_account_proposals(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_account_proposals(uuid, uuid) TO authenticated, service_role;

-- Who may write them: exactly who may update the account (accounts_update).
CREATE OR REPLACE FUNCTION public.can_edit_account_proposals(_user_id uuid, _account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT _user_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.accounts a
     WHERE a.id = _account_id
       AND (public.can_manage_location(_user_id, a.location_id) OR a.assigned_rep = _user_id)
  );
$$;
REVOKE ALL ON FUNCTION public.can_edit_account_proposals(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_edit_account_proposals(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The guard: lifecycle, stamps, totals, frozen content
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_account_proposals_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  asked_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'A new proposal starts as a draft.' USING ERRCODE = '22023';
    END IF;
    NEW.sent_at := NULL;
    NEW.sent_by := NULL;
    NEW.signed_at := NULL;
    NEW.declined_at := NULL;
    NEW.declined_reason := NULL;
    NEW.expired_at := NULL;
    NEW.stage_note := NULL;
    -- A draft has no signing document yet; one is attached when it is sent.
    NEW.document_id := NULL;
    NEW.subtotal := 0;
    NEW.total := 0;
    NEW.pipeline_id := (SELECT a.pipeline_id FROM public.accounts a WHERE a.id = NEW.account_id);
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    NEW.id := OLD.id;
    NEW.account_id := OLD.account_id;
    NEW.pipeline_id := OLD.pipeline_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();

    -- The lines decide the money, never the client.
    SELECT coalesce(sum(l.line_total), 0) INTO NEW.subtotal
      FROM public.account_proposal_lines l
     WHERE l.proposal_id = OLD.id;
    NEW.total := NEW.subtotal;

    -- Only a draft is edited. Once it has gone out, what it says is what was
    -- sent; a changed offer is a new proposal.
    IF OLD.status <> 'draft' AND (
         NEW.title IS DISTINCT FROM OLD.title
      OR NEW.template_id IS DISTINCT FROM OLD.template_id
      OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.terms IS DISTINCT FROM OLD.terms
      -- Deleting an unsigned signing document unlinks it (its foreign key is
      -- ON DELETE SET NULL, an update one trigger level down); nothing else
      -- may change it once sent.
      OR (NEW.document_id IS DISTINCT FROM OLD.document_id
          AND NOT (NEW.document_id IS NULL AND pg_trigger_depth() >= 2))
    ) THEN
      RAISE EXCEPTION 'Only a draft proposal can be edited — this one is %.', OLD.status
        USING ERRCODE = '22023';
    END IF;

    -- The signing document belongs to this account, and the caller can see it.
    IF NEW.document_id IS NOT NULL AND NEW.document_id IS DISTINCT FROM OLD.document_id
       AND NOT EXISTS (
         SELECT 1 FROM public.documents d
          WHERE d.id = NEW.document_id AND d.account_id = OLD.account_id
       ) THEN
      RAISE EXCEPTION 'That document is not on this account.' USING ERRCODE = '22023';
    END IF;

    -- Stamps are written here and nowhere else.
    asked_reason := NEW.declined_reason;
    NEW.sent_at := OLD.sent_at;
    NEW.sent_by := OLD.sent_by;
    NEW.signed_at := OLD.signed_at;
    NEW.declined_at := OLD.declined_at;
    NEW.declined_reason := OLD.declined_reason;
    NEW.expired_at := OLD.expired_at;
    -- stage_note is the advance trigger's to write (it updates from inside a
    -- trigger, so its write arrives one level down); a client's is ignored.
    IF pg_trigger_depth() < 2 THEN
      NEW.stage_note := OLD.stage_note;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF NOT (
           (OLD.status = 'draft' AND NEW.status = 'sent')
        OR (OLD.status = 'sent' AND NEW.status IN ('signed', 'declined', 'expired'))
      ) THEN
        RAISE EXCEPTION 'A % proposal cannot be marked %.', OLD.status, NEW.status
          USING ERRCODE = '22023';
      END IF;
      IF NEW.status = 'sent' THEN
        NEW.sent_at := now();
        NEW.sent_by := coalesce(auth.uid(), OLD.created_by);
      ELSIF NEW.status = 'signed' THEN
        NEW.signed_at := now();
      ELSIF NEW.status = 'declined' THEN
        NEW.declined_at := now();
        NEW.declined_reason := nullif(btrim(coalesce(asked_reason, '')), '');
      ELSIF NEW.status = 'expired' THEN
        NEW.expired_at := now();
      END IF;
    END IF;
  END IF;

  IF NEW.template_version_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.document_template_versions v
        WHERE v.id = NEW.template_version_id AND v.template_id IS NOT DISTINCT FROM NEW.template_id
     ) THEN
    RAISE EXCEPTION 'That template version belongs to a different template.' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_account_proposals_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_proposals_guard ON public.account_proposals;
CREATE TRIGGER account_proposals_guard BEFORE INSERT OR UPDATE ON public.account_proposals
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_proposals_guard();

-- A line write touches its proposal, and the guard above recomputes the total.
CREATE OR REPLACE FUNCTION public.tg_account_proposal_lines_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.account_proposals SET updated_at = now() WHERE id = OLD.proposal_id;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.proposal_id IS DISTINCT FROM OLD.proposal_id) THEN
    UPDATE public.account_proposals SET updated_at = now() WHERE id = NEW.proposal_id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_account_proposal_lines_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_proposal_lines_touch ON public.account_proposal_lines;
CREATE TRIGGER account_proposal_lines_touch
  AFTER INSERT OR UPDATE OR DELETE ON public.account_proposal_lines
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_proposal_lines_touch();

-- ---------------------------------------------------------------------------
-- 4. The stage automation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_account_proposal_advance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := auth.uid();
  acct record;
  cur public.pipeline_stages%ROWTYPE;
  tgt public.pipeline_stages%ROWTYPE;
  note text;
  why text;
  moved boolean := false;
  glow date;
BEGIN
  IF NEW.status NOT IN ('sent', 'signed', 'declined') THEN
    RETURN NULL;
  END IF;

  SELECT a.id, a.name, a.stage_id, a.assigned_rep INTO acct
    FROM public.accounts a WHERE a.id = NEW.account_id FOR UPDATE;
  IF acct.stage_id IS NOT NULL THEN
    SELECT * INTO cur FROM public.pipeline_stages s WHERE s.id = acct.stage_id;
  END IF;

  IF NEW.status = 'declined' THEN
    note := 'Declined — the card stays where it is.';
  -- This function moves the account with the owner's rights, so a signed-in
  -- caller must be someone who may move it by hand. (The signing page has no
  -- signed-in user; its status change came from the signed document.)
  ELSIF caller IS NOT NULL AND NOT public.can_edit_account_proposals(caller, NEW.account_id) THEN
    note := 'Not moved: you cannot move this account.';
  ELSIF cur.id IS NULL THEN
    note := 'Not moved: the account is not on a pipeline stage.';
  ELSE
    IF NEW.status = 'sent' THEN
      SELECT * INTO tgt FROM public.pipeline_stages s
       WHERE s.pipeline_id = cur.pipeline_id AND s.key = 'proposal_sent' AND s.is_active;
      IF tgt.id IS NULL THEN
        note := 'Not moved: this pipeline has no Proposal sent stage.';
      END IF;
    ELSE
      -- Signed: the won stage, the one pipeline_activate_client would pick.
      SELECT * INTO tgt FROM public.pipeline_stages w
       WHERE w.pipeline_id = cur.pipeline_id AND w.is_won AND w.is_active
       ORDER BY (w.key = 'active_client') DESC, w.sort_order
       LIMIT 1;
      IF tgt.id IS NULL THEN
        -- No won stage: the next stage after Proposal sent.
        SELECT n.* INTO tgt FROM public.pipeline_stages n
          JOIN public.pipeline_stages ps
            ON ps.pipeline_id = n.pipeline_id AND ps.key = 'proposal_sent'
         WHERE n.pipeline_id = cur.pipeline_id AND n.is_active AND NOT n.is_lost
           AND n.sort_order > ps.sort_order
         ORDER BY n.sort_order
         LIMIT 1;
      END IF;
      IF tgt.id IS NULL THEN
        note := 'Not moved: this pipeline has no stage to win into.';
      END IF;
    END IF;

    IF tgt.id IS NOT NULL THEN
      -- Never backwards.
      IF cur.id = tgt.id OR cur.is_won OR cur.is_lost OR cur.sort_order >= tgt.sort_order THEN
        note := 'Not moved: already at ' || cur.name || '.';
      ELSE
        why := 'Automation rule: proposal ' || NEW.status || ' — ' || NEW.title;
        BEGIN
          IF tgt.is_won THEN
            -- The drop on Active Clients. The signing date is the green light.
            glow := least(coalesce(NEW.signed_at, now())::date, current_date);
            PERFORM public.pipeline_activate_client(NEW.account_id, glow);
          ELSE
            UPDATE public.accounts
               SET stage_id = tgt.id, stage_changed_at = now()
             WHERE id = NEW.account_id AND stage_id = cur.id;
          END IF;
          moved := EXISTS (
            SELECT 1 FROM public.accounts a WHERE a.id = NEW.account_id AND a.stage_id = tgt.id
          );
        EXCEPTION WHEN OTHERS THEN
          note := 'Not moved: ' || SQLERRM;
        END;

        IF moved THEN
          note := 'Moved to ' || tgt.name || '.';
          -- The history trigger wrote the row; say what moved it, and credit
          -- the rep whose proposal it was when no one was signed in.
          UPDATE public.account_stage_history h
             SET reason = concat_ws(' · ', why, nullif(btrim(coalesce(h.reason, '')), '')),
                 changed_by = coalesce(h.changed_by, NEW.sent_by, NEW.created_by)
           WHERE h.id = (
             SELECT x.id FROM public.account_stage_history x
              WHERE x.account_id = NEW.account_id AND x.to_stage_id = tgt.id
              ORDER BY x.changed_at DESC
              LIMIT 1
           );
        ELSIF note IS NULL THEN
          note := 'Not moved: the account changed stage at the same moment.';
        END IF;
      END IF;
    END IF;
  END IF;

  -- A signature arrives while nobody is looking: tell the rep and the sender.
  -- A notification that cannot be written is not a reason to lose the status.
  IF NEW.status = 'signed' THEN
    BEGIN
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      SELECT who.r, 'automation_task'::public.notification_type, acct.name || ' signed ' || NEW.title,
             note || CASE WHEN moved AND tgt.is_won
                          THEN ' Open the record to finish the onboarding questions.' ELSE '' END,
             'account', NEW.account_id, '/accounts/' || NEW.account_id::text,
             'normal'::public.notification_priority
        FROM (SELECT DISTINCT r FROM unnest(ARRAY[acct.assigned_rep, NEW.sent_by]) AS r) AS who
       WHERE who.r IS NOT NULL AND who.r IS DISTINCT FROM caller;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Proposal % signed, but the notification was not written: %', NEW.id, SQLERRM;
    END;
  END IF;

  UPDATE public.account_proposals SET stage_note = note WHERE id = NEW.id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_account_proposal_advance() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_proposals_advance ON public.account_proposals;
CREATE TRIGGER account_proposals_advance AFTER UPDATE OF status ON public.account_proposals
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.tg_account_proposal_advance();

-- The signed document marks its proposal signed. complete_document_signing_atomic
-- runs as the service role for an anonymous signer, so this must never be the
-- thing that fails a signature: any error is a warning and the signature stands
-- (the rep can still press Mark signed).
CREATE OR REPLACE FUNCTION public.tg_account_proposal_document_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    UPDATE public.account_proposals p
       SET status = CASE WHEN NEW.status::text = 'signed' THEN 'signed' ELSE 'declined' END,
           declined_reason = CASE WHEN NEW.status::text = 'declined'
                                  THEN NEW.declined_reason ELSE p.declined_reason END
     WHERE p.document_id = NEW.id AND p.status = 'sent';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Proposal for document % not updated: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_account_proposal_document_status() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_account_proposal_document_status ON public.documents;
CREATE TRIGGER trg_account_proposal_document_status
  AFTER UPDATE OF status ON public.documents
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status::text IN ('signed', 'declined'))
  EXECUTE FUNCTION public.tg_account_proposal_document_status();

-- ---------------------------------------------------------------------------
-- 5. Grants and policies
-- ---------------------------------------------------------------------------
-- Supabase grants every new public table to the client roles by default.
REVOKE ALL ON public.account_proposals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.account_proposal_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_proposals TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_proposal_lines TO authenticated;
GRANT ALL ON public.account_proposals TO service_role;
GRANT ALL ON public.account_proposal_lines TO service_role;
ALTER TABLE public.account_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_proposal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_proposals_select ON public.account_proposals;
CREATE POLICY account_proposals_select ON public.account_proposals
  FOR SELECT TO authenticated
  USING (
    public.can_view_account_proposals((SELECT auth.uid()), account_id)
    OR created_by = (SELECT auth.uid())
  );

DROP POLICY IF EXISTS account_proposals_insert ON public.account_proposals;
CREATE POLICY account_proposals_insert ON public.account_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND public.can_edit_account_proposals((SELECT auth.uid()), account_id)
  );

DROP POLICY IF EXISTS account_proposals_update ON public.account_proposals;
CREATE POLICY account_proposals_update ON public.account_proposals
  FOR UPDATE TO authenticated
  USING (public.can_edit_account_proposals((SELECT auth.uid()), account_id))
  WITH CHECK (public.can_edit_account_proposals((SELECT auth.uid()), account_id));

DROP POLICY IF EXISTS account_proposals_delete ON public.account_proposals;
CREATE POLICY account_proposals_delete ON public.account_proposals
  FOR DELETE TO authenticated
  USING (status = 'draft' AND public.can_edit_account_proposals((SELECT auth.uid()), account_id));

DROP POLICY IF EXISTS account_proposal_lines_select ON public.account_proposal_lines;
CREATE POLICY account_proposal_lines_select ON public.account_proposal_lines
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.account_proposals p WHERE p.id = account_proposal_lines.proposal_id
  ));

DROP POLICY IF EXISTS account_proposal_lines_write ON public.account_proposal_lines;
CREATE POLICY account_proposal_lines_write ON public.account_proposal_lines
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.account_proposals p
     WHERE p.id = account_proposal_lines.proposal_id AND p.status = 'draft'
       AND public.can_edit_account_proposals((SELECT auth.uid()), p.account_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.account_proposals p
     WHERE p.id = account_proposal_lines.proposal_id AND p.status = 'draft'
       AND public.can_edit_account_proposals((SELECT auth.uid()), p.account_id)
  ));

-- The convention 20260929121000 applies to every RLS table.
DROP POLICY IF EXISTS active_profile_required ON public.account_proposals;
CREATE POLICY active_profile_required ON public.account_proposals
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.account_proposals;
CREATE POLICY anonymous_business_access_denied ON public.account_proposals
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS active_profile_required ON public.account_proposal_lines;
CREATE POLICY active_profile_required ON public.account_proposal_lines
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.account_proposal_lines;
CREATE POLICY anonymous_business_access_denied ON public.account_proposal_lines
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.account_proposals;
    CREATE POLICY portal_customer_denied ON public.account_proposals
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.account_proposal_lines;
    CREATE POLICY portal_customer_denied ON public.account_proposal_lines
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 6. The "Proposal sent" stage on both account pipelines
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  spec record;
  anchor public.pipeline_stages%ROWTYPE;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('22222222-2222-4222-8222-222222222222'::uuid, 'conversation_established', 80::numeric,
       'A proposal is out for signature. Cards move here by themselves when a proposal is sent; signing it makes them an Active Client.'),
      ('11111111-1111-4111-8111-111111111111'::uuid, 'meeting_held', 60::numeric,
       'A proposal is out for signature. Cards move here by themselves when a proposal is sent.')
    ) AS v(pipeline_id, after_key, probability, description)
  LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.pipeline_stages s
       WHERE s.pipeline_id = spec.pipeline_id AND s.key = 'proposal_sent'
    );
    SELECT * INTO anchor FROM public.pipeline_stages s
     WHERE s.pipeline_id = spec.pipeline_id AND s.key = spec.after_key;
    IF anchor.id IS NULL THEN
      RAISE NOTICE 'Pipeline % has no % stage; Proposal sent not added there.',
        spec.pipeline_id, spec.after_key;
      CONTINUE;
    END IF;

    UPDATE public.pipeline_stages s
       SET sort_order = s.sort_order + 10
     WHERE s.pipeline_id = spec.pipeline_id AND s.sort_order > anchor.sort_order;

    INSERT INTO public.pipeline_stages
      (pipeline_id, key, name, sort_order, color, probability, is_won, is_lost, description)
    VALUES
      (spec.pipeline_id, 'proposal_sent', 'Proposal sent', anchor.sort_order + 10, '#EA580C',
       spec.probability, false, false, spec.description)
    ON CONFLICT (pipeline_id, key) DO NOTHING;
    anchor := NULL;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Proposals sent: quotes AND account proposals
-- ---------------------------------------------------------------------------
-- 20260813072103's body, with only the proposals_sent expression changed.
CREATE OR REPLACE FUNCTION public.sales_rep_metrics(_from timestamptz, _to timestamptz)
RETURNS TABLE (
  user_id uuid,
  full_name text,
  jobs_signed_insurance bigint,
  jobs_signed_cash bigint,
  calls_made bigint,
  stage_advances bigint,
  meetings_held bigint,
  proposals_sent bigint,
  accounts_closed bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH people AS (
    SELECT DISTINCT p.user_id AS id, p.full_name
    FROM public.profiles p
    JOIN public.user_roles ur ON ur.user_id = p.user_id
    JOIN public.location_members lm ON lm.user_id = p.user_id
    WHERE ur.role IN ('sales_person','sales_rep','outside_sales_rep','cold_caller','sales_manager','sales_head')
      AND public.can_view_location(auth.uid(), lm.location_id)
      AND coalesce(p.is_active, true)
  )
  SELECT pe.id,
         pe.full_name,
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id AND j.created_at >= _from AND j.created_at <= _to
              AND coalesce(j.job_type, 'insurance') <> 'cash'),
         (SELECT count(*) FROM public.jobs j
            JOIN public.accounts a ON a.id = j.account_id
            WHERE a.assigned_rep = pe.id AND j.created_at >= _from AND j.created_at <= _to
              AND j.job_type = 'cash'),
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type = 'call'
              AND t.occurred_at >= _from AND t.occurred_at <= _to),
         (SELECT count(*) FROM public.account_stage_history h
            WHERE h.changed_by = pe.id AND h.changed_at >= _from AND h.changed_at <= _to),
         (SELECT count(*) FROM public.touchpoints t
            WHERE t.created_by = pe.id AND t.type IN ('meeting_in_person','meeting_virtual')
              AND coalesce(t.meeting_held, true)
              AND t.occurred_at >= _from AND t.occurred_at <= _to),
         (SELECT count(*) FROM public.quotes q
            WHERE q.created_by = pe.id AND q.status IN ('submitted','approved','rejected')
              AND q.created_at >= _from AND q.created_at <= _to)
         + (SELECT count(*) FROM public.account_proposals ap
            WHERE ap.sent_by = pe.id AND ap.sent_at IS NOT NULL
              AND ap.sent_at >= _from AND ap.sent_at <= _to),
         (SELECT count(*) FROM public.account_stage_history h
            JOIN public.pipeline_stages s ON s.id = h.to_stage_id
            WHERE h.changed_by = pe.id AND s.is_won AND h.changed_at >= _from AND h.changed_at <= _to)
  FROM people pe;
$$;

REVOKE ALL ON FUNCTION public.sales_rep_metrics(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_rep_metrics(timestamptz, timestamptz) TO authenticated;

-- ===========================================================================
-- Verification after applying
-- ===========================================================================
--
--   -- 1. The stage is in place on both pipelines, between its neighbours.
--   SELECT p.name, s.key, s.name, s.sort_order FROM public.pipeline_stages s
--     JOIN public.pipelines p ON p.id = s.pipeline_id
--    WHERE p.id IN ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111')
--    ORDER BY p.name, s.sort_order;
--   -- expected: conversation_established < proposal_sent < active_client, and
--   --           meeting_held < proposal_sent < vendor_onboarding
--
--   -- 2. RLS on, no anon grant.
--   SELECT relname, relrowsecurity FROM pg_class
--    WHERE relname IN ('account_proposals', 'account_proposal_lines');
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name IN ('account_proposals', 'account_proposal_lines') AND grantee = 'anon';
--   -- expected: true, true; no rows
--
--   -- 3. Proposals sent still counts quotes, and now proposals.
--   SELECT prosrc LIKE '%public.account_proposals ap%' FROM pg_proc
--    WHERE proname = 'sales_rep_metrics';
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_account_proposal_document_status ON public.documents;
--   DROP TABLE IF EXISTS public.account_proposal_lines, public.account_proposals;
--   DROP FUNCTION IF EXISTS public.tg_account_proposal_document_status(),
--     public.tg_account_proposal_advance(), public.tg_account_proposal_lines_touch(),
--     public.tg_account_proposals_guard(), public.can_edit_account_proposals(uuid, uuid),
--     public.can_view_account_proposals(uuid, uuid);
--   -- then re-apply sales_rep_metrics from 20260813072103, and move any
--   -- account off proposal_sent before deleting that stage (stage_id is
--   -- ON DELETE RESTRICT) and shifting the later stages back up 10.
