/**
 * What a vehicle costs to insure and to finance or lease (5 Nov review, T8).
 *
 * One row per vehicle (vehicle_costs, 20261109140000). Insurance is usually
 * paid by the year and finance by the month, so each amount keeps the period
 * it is paid in; the yearly figure is what the overhead engine sums (T9,
 * fleet_overhead_sync).
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type CostPeriod = "monthly" | "yearly";
export type Ownership = "owned" | "financed" | "leased";

export type VehicleCosts = {
  vehicle_id: string;
  insurance_amount: number | null;
  insurance_period: CostPeriod;
  ownership: Ownership;
  finance_amount: number | null;
  finance_period: CostPeriod;
  updated_at?: string | null;
};

export const PERIOD_LABEL: Record<CostPeriod, string> = { monthly: "Monthly", yearly: "Yearly" };
export const PERIOD_SUFFIX: Record<CostPeriod, string> = { monthly: "/ month", yearly: "/ year" };
export const OWNERSHIP_LABEL: Record<Ownership, string> = {
  owned: "Owned",
  financed: "Financed",
  leased: "Leased",
};

export const emptyVehicleCosts = (vehicleId: string): VehicleCosts => ({
  vehicle_id: vehicleId,
  insurance_amount: null,
  insurance_period: "yearly",
  ownership: "owned",
  finance_amount: null,
  finance_period: "monthly",
});

/** An amount paid per period, as a year's worth (to the cent). */
export const perYear = (amount: number | null, period: CostPeriod): number =>
  amount == null ? 0 : Math.round(amount * (period === "monthly" ? 12 : 1) * 100) / 100;

/** The finance or lease cost a year; nothing while the vehicle is owned. */
export const financePerYear = (
  c: Pick<VehicleCosts, "ownership" | "finance_amount" | "finance_period">,
) => (c.ownership === "owned" ? 0 : perYear(c.finance_amount, c.finance_period));

/** null when the table is not there yet (migration not applied). */
export async function fetchVehicleCosts(vehicleId: string): Promise<VehicleCosts | null> {
  const { data, error } = await supabase
    .from("vehicle_costs" as never)
    .select(
      "vehicle_id, insurance_amount, insurance_period, ownership, finance_amount, finance_period, updated_at",
    )
    .eq("vehicle_id", vehicleId)
    .maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  const row = data as (VehicleCosts & Record<string, unknown>) | null;
  if (!row) return emptyVehicleCosts(vehicleId);
  return {
    ...row,
    insurance_amount: row.insurance_amount == null ? null : Number(row.insurance_amount),
    finance_amount: row.finance_amount == null ? null : Number(row.finance_amount),
  };
}

export async function saveVehicleCosts(c: VehicleCosts): Promise<void> {
  const { error } = await supabase.from("vehicle_costs" as never).upsert(
    {
      vehicle_id: c.vehicle_id,
      insurance_amount: c.insurance_amount,
      insurance_period: c.insurance_period,
      ownership: c.ownership,
      finance_amount: c.ownership === "owned" ? null : c.finance_amount,
      finance_period: c.finance_period,
    } as never,
    { onConflict: "vehicle_id" },
  );
  if (error) throw error;
}

/**
 * Every listed vehicle's costs at once, for the Fleet costs sheet (the
 * spreadsheet view, 5 Nov review). A vehicle with no row yet gets the empty
 * defaults. null when the table is not there yet.
 */
export async function fetchFleetCosts(
  vehicleIds: readonly string[],
): Promise<Map<string, VehicleCosts> | null> {
  const out = new Map(vehicleIds.map((id) => [id, emptyVehicleCosts(id)]));
  if (!vehicleIds.length) return out;
  const { data, error } = await supabase
    .from("vehicle_costs" as never)
    .select(
      "vehicle_id, insurance_amount, insurance_period, ownership, finance_amount, finance_period, updated_at",
    )
    .in("vehicle_id", vehicleIds as string[]);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  for (const r of (data ?? []) as (VehicleCosts & Record<string, unknown>)[]) {
    out.set(r.vehicle_id, {
      ...r,
      insurance_amount: r.insurance_amount == null ? null : Number(r.insurance_amount),
      finance_amount: r.finance_amount == null ? null : Number(r.finance_amount),
    });
  }
  return out;
}

/** Saves several vehicles in one request, so the overhead engine re-sums once. */
export async function saveFleetCosts(rows: readonly VehicleCosts[]): Promise<void> {
  if (!rows.length) return;
  const { error } = await supabase.from("vehicle_costs" as never).upsert(
    rows.map((c) => ({
      vehicle_id: c.vehicle_id,
      insurance_amount: c.insurance_amount,
      insurance_period: c.insurance_period,
      ownership: c.ownership,
      finance_amount: c.ownership === "owned" ? null : c.finance_amount,
      finance_period: c.finance_period,
    })) as never,
    { onConflict: "vehicle_id" },
  );
  if (error) throw error;
}

/** Whether two cost rows say the same thing (what the sheet counts as a change). */
export function sameCosts(a: VehicleCosts, b: VehicleCosts): boolean {
  return (
    a.insurance_amount === b.insurance_amount &&
    a.insurance_period === b.insurance_period &&
    a.ownership === b.ownership &&
    (a.ownership === "owned" || a.finance_amount === b.finance_amount) &&
    a.finance_period === b.finance_period
  );
}
