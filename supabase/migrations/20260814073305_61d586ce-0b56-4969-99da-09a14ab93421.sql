
CREATE TABLE public.leaderboard_challenges (
  id uuid primary key default gen_random_uuid(),
  location_id uuid references public.locations(id) on delete cascade,
  name text not null,
  description text,
  metric text not null default 'contracts_signed',
  target numeric not null default 25,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null default (now() + interval '7 days'),
  bonus_text text,
  active boolean not null default true,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leaderboard_challenges TO authenticated;
GRANT ALL ON public.leaderboard_challenges TO service_role;
ALTER TABLE public.leaderboard_challenges ENABLE ROW LEVEL SECURITY;
CREATE POLICY "challenges_read" ON public.leaderboard_challenges FOR SELECT TO authenticated USING (true);
CREATE POLICY "challenges_write" ON public.leaderboard_challenges FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(),'sales_head'))
  WITH CHECK (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(),'sales_head'));

CREATE TABLE public.leaderboard_achievements (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  icon text not null default 'award',
  color text not null default '#1B6ACB',
  metric text not null default 'contracts_signed',
  threshold numeric not null default 1,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leaderboard_achievements TO authenticated;
GRANT ALL ON public.leaderboard_achievements TO service_role;
ALTER TABLE public.leaderboard_achievements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "achievements_read" ON public.leaderboard_achievements FOR SELECT TO authenticated USING (true);
CREATE POLICY "achievements_write" ON public.leaderboard_achievements FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(),'sales_head'))
  WITH CHECK (public.is_privileged(auth.uid()) OR public.has_role(auth.uid(),'sales_head'));

CREATE TRIGGER lc_updated BEFORE UPDATE ON public.leaderboard_challenges
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER la_updated BEFORE UPDATE ON public.leaderboard_achievements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.leaderboard_achievements (key,name,description,icon,color,metric,threshold,sort_order) VALUES
  ('shield','Consistency Shield','Ten or more touchpoints this period','shield','#1B6ACB','touchpoints',10,1),
  ('firestarter','Firestarter','Five or more fire incidents accepted','flame','#E8833A','incidents_accepted',5,2),
  ('closer','Closer','Five or more contracts signed','target','#12805C','contracts_signed',5,3),
  ('rainmaker','Rainmaker','Three or more jobs won','trophy','#C8951C','jobs_won',3,4);

INSERT INTO public.leaderboard_challenges (name,description,metric,target,bonus_text,starts_at,ends_at) VALUES
  ('Firestarter Challenge','Who can close the most fire jobs this week?','contracts_signed',25,
   'Top finisher earns 2x points + $250 bonus!', date_trunc('week', now()), date_trunc('week', now()) + interval '7 days');
