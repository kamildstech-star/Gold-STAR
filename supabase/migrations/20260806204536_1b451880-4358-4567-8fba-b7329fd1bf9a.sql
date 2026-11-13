CREATE TABLE public.user_table_prefs (
  user_id uuid NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  table_key text NOT NULL,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, table_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_table_prefs TO authenticated;
GRANT ALL ON public.user_table_prefs TO service_role;

ALTER TABLE public.user_table_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own table preferences"
ON public.user_table_prefs FOR ALL TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER update_user_table_prefs_updated_at
BEFORE UPDATE ON public.user_table_prefs
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();