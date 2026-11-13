-- Supabase's project-level default privileges grant broad table rights to
-- anon and authenticated when postgres creates a table. Replace those
-- defaults with this feature's intended API surface; RLS remains enabled.

REVOKE ALL ON TABLE public.google_review_links FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.google_review_links TO authenticated;
