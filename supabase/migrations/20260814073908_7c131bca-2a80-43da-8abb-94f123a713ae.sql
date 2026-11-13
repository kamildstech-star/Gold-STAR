
CREATE TABLE public.chase_saved_searches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  query text not null default '',
  filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
CREATE INDEX chase_saved_searches_user_idx ON public.chase_saved_searches (user_id, created_at desc);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chase_saved_searches TO authenticated;
GRANT ALL ON public.chase_saved_searches TO service_role;
ALTER TABLE public.chase_saved_searches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_saved_searches" ON public.chase_saved_searches FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));
CREATE TRIGGER chase_saved_searches_updated BEFORE UPDATE ON public.chase_saved_searches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
