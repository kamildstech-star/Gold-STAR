REVOKE ALL ON FUNCTION public.demo_data_total() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_demo_data() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.demo_data_counts() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_demo_data() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demo_data_total() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.demo_data_counts() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seed_demo_data() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_demo_data() TO authenticated, service_role;