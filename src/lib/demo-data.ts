import { supabase } from "@/integrations/supabase/client";
import { logActivity } from "@/lib/activity";

export type DemoCount = { table_name: string; row_count: number };

/**
 * Total demo rows across every flagged table. Cheap enough to poll for the
 * persistent banner — it is a single SECURITY DEFINER count.
 */
export async function fetchDemoTotal(): Promise<number> {
  const { data, error } = await supabase.rpc("demo_data_total");
  if (error) throw error;
  return Number(data ?? 0);
}

export async function fetchDemoCounts(): Promise<DemoCount[]> {
  const { data, error } = await supabase.rpc("demo_data_counts");
  if (error) throw error;
  return ((data ?? []) as { table_name: string; row_count: number }[])
    .map((r) => ({ table_name: r.table_name, row_count: Number(r.row_count) }))
    .filter((r) => r.row_count > 0)
    .sort((a, b) => b.row_count - a.row_count);
}

export async function seedDemoData(): Promise<DemoCount[]> {
  // Accounts first. seed_demo_jobs only makes a job for a demo account that
  // already exists, so calling it first on a fresh seed (or after a purge)
  // made no demo jobs — and seed_demo_data's invoices then landed on REAL
  // jobs. seed_demo_data now makes the demo accounts, then the demo jobs
  // (calling seed_demo_jobs itself), then invoices on demo jobs only
  // (migration 20261016130000). The separate call after it adds nothing once
  // that is applied; it is kept so a database without it still gets its jobs.
  // Equipment is never seeded — the Kahi sync owns those rows.
  const { data, error } = await supabase.rpc("seed_demo_data");
  if (error) throw error;
  const jobs = await supabase.rpc("seed_demo_jobs");
  if (jobs.error) throw jobs.error;
  // Pipelines last: it fills the relationship + client-health boards and adds
  // owners, values and next activities to whatever prospecting cards exist.
  const pipes = await supabase.rpc("seed_demo_pipelines");
  if (pipes.error) throw pipes.error;
  // Field visits: gives Routes (map, by-day and coverage) something to draw.
  const visits = await supabase.rpc("seed_demo_visits");
  if (visits.error) throw visits.error;
  // Street addresses near each office, so demo stops are actually routable.
  const addresses = await supabase.rpc("seed_demo_addresses");
  if (addresses.error) throw addresses.error;
  const rows = [
    ...((jobs.data ?? []) as { table_name: string; inserted_count: number }[]),
    ...((data ?? []) as { table_name: string; inserted_count: number }[]),
    ...((pipes.data ?? []) as { table_name: string; inserted_count: number }[]),
    ...((visits.data ?? []) as { table_name: string; inserted_count: number }[]),
    ...((addresses.data ?? []) as { table_name: string; inserted_count: number }[]),
  ];
  const seeded = rows.map((r) => ({
    table_name: r.table_name,
    row_count: Number(r.inserted_count),
  }));
  await logActivity({
    module: "admin",
    event_type: "demo.seeded",
    summary: `Seeded ${seeded.reduce((s, r) => s + r.row_count, 0)} demo rows`,
    detail: { tables: seeded },
  });
  return seeded;
}

/** One action, no partial states: every is_demo row goes. */
export async function purgeDemoData(): Promise<DemoCount[]> {
  const { data, error } = await supabase.rpc("purge_demo_data");
  if (error) throw error;
  const purged = ((data ?? []) as { table_name: string; deleted_count: number }[])
    .map((r) => ({ table_name: r.table_name, row_count: Number(r.deleted_count) }))
    .filter((r) => r.row_count > 0);
  await logActivity({
    module: "admin",
    event_type: "demo.purged",
    summary: `Purged ${purged.reduce((s, r) => s + r.row_count, 0)} demo rows`,
    detail: { tables: purged },
  });
  return purged;
}
