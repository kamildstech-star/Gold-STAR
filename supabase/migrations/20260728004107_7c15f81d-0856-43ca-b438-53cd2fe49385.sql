
-- Extensions
CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================
-- Roles
-- ============================================================
CREATE TYPE public.app_role AS ENUM ('admin', 'office', 'field');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Security-definer helper avoids recursive RLS on user_roles itself.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  );
$$;

CREATE POLICY "Users read own role assignments"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins manage roles"
  ON public.user_roles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- Locations (Gold Star offices)
-- ============================================================
CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  address text NOT NULL,
  locality text,
  region text NOT NULL,
  postal_code text,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  geom geography(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography) STORED,
  territory geography(Polygon, 4326),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX locations_geom_idx ON public.locations USING gist (geom);
CREATE INDEX locations_territory_idx ON public.locations USING gist (territory);

GRANT SELECT ON public.locations TO authenticated;
GRANT ALL ON public.locations TO service_role;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users view offices"
  ON public.locations FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins manage offices"
  ON public.locations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed the 6 confirmed offices. Coordinates are approximate street-level geocodes.
INSERT INTO public.locations (code, name, address, locality, region, postal_code, lat, lon) VALUES
  ('NY', 'Brooklyn, NY',    '1733 Flatbush Ave',              'Brooklyn',    'NY', '11210', 40.62440, -73.95640),
  ('NJ', 'Lakewood, NJ',    '1309 Ridge Ave',                 'Lakewood',    'NJ', '08701', 40.07790, -74.21790),
  ('NC', 'Garner, NC',      'Garner',                         'Garner',      'NC', '27529', 35.71130, -78.61410),
  ('GA', 'Atlanta, GA',     '1658 Lavista Rd NE',             'Atlanta',     'GA', '30329', 33.82070, -84.31150),
  ('CA', 'Los Angeles, CA', '345 N La Brea, Ste 208',         'Los Angeles', 'CA', '90036', 34.07790, -118.34440),
  ('MI', 'Southfield, MI',  '21455 Melrose Ave, Bldg R Ste 5','Southfield',  'MI', '48075', 42.47950, -83.24720);

-- ============================================================
-- Location members (RLS pivot for office/field access)
-- ============================================================
CREATE TYPE public.location_member_role AS ENUM ('manager', 'office', 'field');

CREATE TABLE public.location_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.location_member_role NOT NULL DEFAULT 'field',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, user_id)
);

CREATE INDEX location_members_user_idx ON public.location_members (user_id);
CREATE INDEX location_members_location_idx ON public.location_members (location_id);

GRANT SELECT ON public.location_members TO authenticated;
GRANT ALL ON public.location_members TO service_role;
ALTER TABLE public.location_members ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_member_of(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.location_members
    WHERE user_id = _user_id AND location_id = _location_id
  );
$$;

CREATE POLICY "Members view their office rosters"
  ON public.location_members FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_member_of(auth.uid(), location_id)
    OR public.has_role(auth.uid(), 'admin')
  );

CREATE POLICY "Admins manage memberships"
  ON public.location_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ============================================================
-- Profiles (display name for members; auth.users is off-limits)
-- ============================================================
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users view profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users update own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users insert own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Auto-create a profile row on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (user_id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name')
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- Nearest-branch helper used by future modules
-- ============================================================
CREATE OR REPLACE FUNCTION public.nearest_location(_lat double precision, _lon double precision, _max_miles double precision DEFAULT 75)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.locations
  WHERE active
    AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography, _max_miles * 1609.34)
  ORDER BY geom <-> ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography
  LIMIT 1;
$$;

-- updated_at helper reused across tables
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

CREATE TRIGGER locations_updated_at BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
