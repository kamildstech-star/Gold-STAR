/**
 * A job's own T&M rate sheet (TM2, 27 Oct) — a layer over Settings › T&M rate
 * codes. A row in job_tm_rates is that job's rate and wins; with no row the
 * job reads the Settings rate. New jobs snapshot the Settings rates when they
 * are created (migration 20261027161000), so a later change in Settings never
 * re-prices a job already running.
 *
 * "No rate set for 100, 102 … — billed at $0" on the T&M bill becomes "set the
 * rate for this job": setJobTmRate, one row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isMissingSchema } from "@/lib/schema-fallback";
import type { PricedCode } from "@/lib/tm-bill";
import { parseRate } from "@/lib/tm-rate-codes-admin";

/** code → the job's client rate. null = the table is not on this database yet. */
export async function loadJobTmRates(
  client: SupabaseClient,
  jobId: string,
): Promise<Map<string, number | null> | null> {
  const { data, error } = await client
    .from("job_tm_rates")
    .select("code, rate")
    .eq("job_id", jobId);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return new Map(
    ((data ?? []) as { code: string; rate: number | string | null }[]).map((r) => [
      r.code.toUpperCase(),
      r.rate == null ? null : Number(r.rate),
    ]),
  );
}

/** code → the job's internal cost rate, for a caller who may see the job's costs. */
export async function loadJobTmCostRates(
  client: SupabaseClient,
  jobId: string,
): Promise<Map<string, number | null> | null> {
  const { data, error } = await client.rpc(
    "job_tm_rate_costs" as never,
    { _job_id: jobId } as never,
  );
  if (error) return null;
  return new Map(
    ((data ?? []) as { code: string; cost_rate: number | string | null }[]).map((r) => [
      r.code.toUpperCase(),
      r.cost_rate == null ? null : Number(r.cost_rate),
    ]),
  );
}

/**
 * The job's rates over Settings. A job row with a rate wins; a job row left
 * blank, or no row, reads Settings. Each code says where its rate came from.
 */
export function withJobRates(
  codes: readonly PricedCode[],
  jobRates: ReadonlyMap<string, number | null> | null,
): (PricedCode & { rateSource: "job" | "settings" | "none" })[] {
  return codes.map((c) => {
    const own = jobRates?.get(c.code.toUpperCase());
    if (own != null) return { ...c, rate: own, rateSource: "job" as const };
    return { ...c, rateSource: c.rate != null ? ("settings" as const) : ("none" as const) };
  });
}

/** Same layering for cost rates (TM7): job cost rate, else Settings cost rate. */
export function withJobCostRates(
  codes: readonly PricedCode[],
  settingsCosts: ReadonlyMap<string, number | null> | null,
  jobCosts: ReadonlyMap<string, number | null> | null,
): PricedCode[] {
  return codes.map((c) => {
    const key = c.code.toUpperCase();
    const own = jobCosts?.get(key);
    const base = settingsCosts?.get(c.code) ?? settingsCosts?.get(key) ?? null;
    return { ...c, costRate: own ?? base };
  });
}

/** Set (or with a blank, clear) this job's rate for one code. */
export async function setJobTmRate(
  client: SupabaseClient,
  jobId: string,
  code: string,
  raw: string,
): Promise<void> {
  const rate = parseRate(raw);
  const { error } = await client
    .from("job_tm_rates")
    .upsert({ job_id: jobId, code: code.toUpperCase(), rate } as never, {
      onConflict: "job_id,code",
    });
  if (error) throw error;
}
