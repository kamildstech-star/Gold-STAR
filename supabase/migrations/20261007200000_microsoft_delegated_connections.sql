-- Microsoft 365 delegated access: one connection per person.
--
-- WRITTEN, NOT APPLIED. Two new tables, no functions, nothing existing
-- changes. The app works before this is applied: the Security page's Outlook
-- card says "not available yet" and nothing else reads these tables.
--
-- Why: IT (Chaim Stern, SM Tech Solutions) asked whether mail and calendar
-- access could be delegated instead of an application credential that can
-- reach every mailbox in the tenant. Option A of
-- docs/OUTLOOK-ACCESS-PROPOSAL.md: each person signs in to Microsoft from
-- their own Security page, and the CRM keeps a refresh token that can reach
-- exactly what that person can reach.
--
-- 1. microsoft_connections — the non-secret half: which Microsoft account,
--    which scopes were granted, connected / needs_reconnect, the last error.
--    A person may READ their own row and nobody else's. Nobody writes it
--    from the browser: connect, refresh and disconnect are server code on
--    the service role (src/lib/microsoft-delegated.server.ts).
--
-- 2. microsoft_connection_secrets — the refresh token, AES-256-GCM encrypted
--    by the server with the credential store's key (INTEGRATION_CRED_KEY),
--    with the owner's user id as associated data so a ciphertext moved to
--    another row will not decrypt. `authenticated` and `anon` hold NO grant
--    on this table at all, so PostgREST cannot return it to any browser, the
--    owner's included. Only the service role reads it.
--
-- One Microsoft account belongs to one Recovery Hub user
-- (microsoft_connections_ms_account): the second person to connect the same
-- account is refused rather than quietly sharing a mailbox.
--
-- Both rows go when the auth user is deleted. Deactivating a profile does not
-- delete them, but the server refuses to use the token of an inactive person
-- and RLS hides the row from them (active_profile_required).
--
-- Re-runnable: IF NOT EXISTS / DROP POLICY IF EXISTS.

CREATE TABLE IF NOT EXISTS public.microsoft_connections (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  -- Entra object id (the id_token's oid; Graph /me id).
  ms_user_id text NOT NULL,
  upn text NOT NULL,
  display_name text,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'needs_reconnect')),
  last_error text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  last_refreshed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS microsoft_connections_ms_account
  ON public.microsoft_connections (tenant_id, ms_user_id);
CREATE INDEX IF NOT EXISTS microsoft_connections_upn
  ON public.microsoft_connections (lower(upn));

CREATE TABLE IF NOT EXISTS public.microsoft_connection_secrets (
  user_id uuid PRIMARY KEY
    REFERENCES public.microsoft_connections(user_id) ON DELETE CASCADE,
  refresh_token_ciphertext text NOT NULL,
  refresh_token_iv text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Grants. Supabase's default privileges hand every new public table to anon
-- and authenticated; take that back explicitly, then give back only SELECT on
-- the metadata table.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.microsoft_connections FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.microsoft_connection_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.microsoft_connections TO authenticated;
GRANT ALL ON public.microsoft_connections TO service_role;
GRANT ALL ON public.microsoft_connection_secrets TO service_role;

ALTER TABLE public.microsoft_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.microsoft_connection_secrets ENABLE ROW LEVEL SECURITY;

-- Your own row only. Admins see the per-person list through a server function
-- that returns names and statuses, not through a wider policy here.
DROP POLICY IF EXISTS microsoft_connections_select_own ON public.microsoft_connections;
CREATE POLICY microsoft_connections_select_own ON public.microsoft_connections
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS active_profile_required ON public.microsoft_connections;
CREATE POLICY active_profile_required ON public.microsoft_connections
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));

-- microsoft_connection_secrets has RLS on and no permissive policy for any
-- client role: even a grant added by mistake later would return no rows. The
-- restrictive policies below match the convention 20260929121000 applies to
-- every RLS table (and that its sweep would add on a re-run anyway).
DROP POLICY IF EXISTS active_profile_required ON public.microsoft_connection_secrets;
CREATE POLICY active_profile_required ON public.microsoft_connection_secrets
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.microsoft_connections;
CREATE POLICY anonymous_business_access_denied ON public.microsoft_connections
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.microsoft_connection_secrets;
CREATE POLICY anonymous_business_access_denied ON public.microsoft_connection_secrets
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.microsoft_connections;
    CREATE POLICY portal_customer_denied ON public.microsoft_connections
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
    DROP POLICY IF EXISTS portal_customer_denied ON public.microsoft_connection_secrets;
    CREATE POLICY portal_customer_denied ON public.microsoft_connection_secrets
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;
