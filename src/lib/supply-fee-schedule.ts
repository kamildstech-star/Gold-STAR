/**
 * The Supplies Fee Schedule: what a regular job charges for supplies, as a
 * flat fee for every day on site, by the kind of work.
 *
 * David, 6 Nov call (his Falcon-GSR.xlsx, "Tabels" sheet): "every day that
 * we're on site we charge a certain amount for supplies automatically … each
 * thing here is a different dollar amount and it multiplies it by the days
 * … the job ledger should pull these numbers multiplied by the amount of
 * days we're on site." T&M jobs are not here: they bill each supply on the
 * T&M daily supply list instead.
 *
 * The figures below were read off his screen share and are the fallback.
 * A catalog item with the matching `GSC-SUPPLY-*` code (Billing & Costs ›
 * General Rates) overrides a figure, so the office changes a fee without a
 * release — the Job Calculator already reads Water, Mold and Fire this way.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { roundMoneyLoose } from "@/lib/money";

export const SUPPLY_FEE_KINDS = [
  "water",
  "extraction",
  "equipment",
  "mold",
  "air_sample",
  "gut_job",
  "sewage",
  "bio",
  "board_up",
  "encapsulation",
  "fire",
] as const;
export type SupplyFeeKind = (typeof SUPPLY_FEE_KINDS)[number];

export const SUPPLY_FEE_LABEL: Record<SupplyFeeKind, string> = {
  water: "Water",
  extraction: "Extraction",
  equipment: "Equipment",
  mold: "Mold",
  air_sample: "Air sample",
  gut_job: "Gut job",
  sewage: "Sewage",
  bio: "BIO",
  board_up: "Board up",
  encapsulation: "Encapsulation",
  fire: "Fire",
};

/** Dollars per day on site (David's sheet, 6 Nov). */
export const SUPPLY_FEE_PER_DAY: Record<SupplyFeeKind, number> = {
  water: 250,
  extraction: 100,
  equipment: 50,
  mold: 250,
  air_sample: 100,
  gut_job: 500,
  sewage: 500,
  bio: 500,
  board_up: 500,
  encapsulation: 500,
  fire: 300,
};

/** One catalog code per kind; Water, Mold and Fire are the calculator's own. */
export const SUPPLY_FEE_CODES: Record<SupplyFeeKind, string> = {
  water: "GSC-SUPPLY-WATER",
  extraction: "GSC-SUPPLY-EXTRACTION",
  equipment: "GSC-SUPPLY-EQUIPMENT",
  mold: "GSC-SUPPLY-MOLD",
  air_sample: "GSC-SUPPLY-AIR-SAMPLE",
  gut_job: "GSC-SUPPLY-GUT-JOB",
  sewage: "GSC-SUPPLY-SEWAGE",
  bio: "GSC-SUPPLY-BIO",
  board_up: "GSC-SUPPLY-BOARD-UP",
  encapsulation: "GSC-SUPPLY-ENCAPSULATION",
  fire: "GSC-SUPPLY-FIRE",
};

/**
 * Which fee a job's loss type takes. The loss type is a managed option-list
 * key ("water_mitigation", "mold_remediation", "fire_smoke", "sewage" …), so
 * this reads the words rather than trusting one exact spelling. Null when
 * the kind of work has no fee on the sheet (storm, cleaning, vandalism …).
 */
export function supplyFeeKindFor(lossTypeKey: string | null | undefined): SupplyFeeKind | null {
  const k = (lossTypeKey ?? "").toLowerCase().replace(/[^a-z]+/g, "_");
  if (!k) return null;
  if (k.includes("extraction")) return "extraction";
  if (k.includes("air_sample") || k.includes("airsample") || k.includes("air_quality"))
    return "air_sample";
  if (k.includes("gut")) return "gut_job";
  if (k.includes("sewage") || k.includes("sewer")) return "sewage";
  if (k.includes("bio")) return "bio";
  if (k.includes("board")) return "board_up";
  if (k.includes("encapsul")) return "encapsulation";
  if (k.includes("equipment")) return "equipment";
  if (k.includes("mold") || k.includes("mould")) return "mold";
  if (k.includes("fire") || k.includes("smoke")) return "fire";
  if (k.includes("water") || k.includes("flood")) return "water";
  return null;
}

export type SupplyFeeSchedule = Record<SupplyFeeKind, number>;

/**
 * The schedule in force: the sheet's figures, each replaced by the matching
 * catalog item's price when one is set. Any read error leaves the sheet's
 * figures — the ledger still has a number.
 */
export async function loadSupplyFeeSchedule(client: SupabaseClient): Promise<SupplyFeeSchedule> {
  const schedule: SupplyFeeSchedule = { ...SUPPLY_FEE_PER_DAY };
  try {
    const { data } = await client
      .from("estimate_catalog_items")
      .select("code, default_unit_price, is_active")
      .in("code", Object.values(SUPPLY_FEE_CODES));
    for (const row of (data ?? []) as {
      code: string;
      default_unit_price: number | string | null;
      is_active: boolean;
    }[]) {
      if (!row.is_active) continue;
      const price = Number(row.default_unit_price);
      const kind = (Object.keys(SUPPLY_FEE_CODES) as SupplyFeeKind[]).find(
        (k) => SUPPLY_FEE_CODES[k] === row.code,
      );
      if (kind && price > 0) schedule[kind] = price;
    }
  } catch {
    /* the sheet's figures stand */
  }
  return schedule;
}

/**
 * The ledger's Supplies Charge for a regular job: the kind's daily fee × the
 * days on site. Null when the job has no fee kind (then the ledger falls back
 * to each supply × its charge) or no days yet.
 */
export function dailySuppliesCharge(
  lossTypeKey: string | null | undefined,
  days: number | null | undefined,
  schedule: SupplyFeeSchedule = SUPPLY_FEE_PER_DAY,
): {
  amount: number;
  unpriced: number;
  source: string;
  kind: SupplyFeeKind;
  perDay: number;
} | null {
  const kind = supplyFeeKindFor(lossTypeKey);
  if (!kind) return null;
  const perDay = schedule[kind];
  const n = Math.max(0, Math.floor(days ?? 0));
  return {
    amount: roundMoneyLoose(perDay * n),
    unpriced: 0,
    source: `Supplies fee schedule — ${SUPPLY_FEE_LABEL[kind]} $${perDay}/day × ${n} day${n === 1 ? "" : "s"} on site`,
    kind,
    perDay,
  };
}

/**
 * The key the fee lookup should read for a job: the managed loss type's key
 * (`loss_type_id` → option_list_values.key, "water_mitigation") when the job
 * has one, else the legacy enum (`loss_type`, "water"). A job created through
 * intake may carry only the id, so reading the enum alone finds nothing.
 */
export async function resolveLossTypeKey(
  client: SupabaseClient,
  job: { loss_type?: string | null; loss_type_id?: string | null },
): Promise<string | null> {
  if (job.loss_type_id) {
    try {
      const { data } = await client
        .from("option_list_values")
        .select("key")
        .eq("id", job.loss_type_id)
        .maybeSingle();
      const key = (data as { key?: string } | null)?.key;
      if (key) return key;
    } catch {
      /* fall through to the enum */
    }
  }
  return job.loss_type ?? null;
}

/** The same, for many jobs at once (the ledger report): one read of the keys. */
export async function resolveLossTypeKeys(
  client: SupabaseClient,
  jobs: readonly { id: string; loss_type?: string | null; loss_type_id?: string | null }[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(jobs.map((j) => j.loss_type_id).filter((v): v is string => !!v))];
  const keyOf = new Map<string, string>();
  if (ids.length) {
    try {
      const { data } = await client.from("option_list_values").select("id, key").in("id", ids);
      for (const r of (data ?? []) as { id: string; key: string }[]) keyOf.set(r.id, r.key);
    } catch {
      /* enum fallback below */
    }
  }
  return new Map(
    jobs.map((j) => [j.id, (j.loss_type_id && keyOf.get(j.loss_type_id)) || j.loss_type || null]),
  );
}
