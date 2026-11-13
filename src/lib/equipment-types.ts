/**
 * EQUIPMENT TYPES AS DATA (Billing & Costs prompt 3) — the Equipment module's
 * types are rows in `equipment_types` (migration 20261030120000), and from
 * 20261031120000 an administrator adds, renames, archives and restores them
 * in the module's "Types" admin (equipment_type_save). A new type also joins
 * the register's equipment_type enum, which never loses a value — so an
 * archived type is only hidden from pickers; units of it keep it.
 *
 * Money hangs off a type as money_values item EQ:<key> (T&M rate, cost).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import { useManagedOptions, optionsFrom, type ManagedOption } from "@/lib/managed-options";
import { isMissingSchema } from "@/lib/schema-fallback";

export type EquipmentTypeRow = {
  key: string;
  label: string;
  active: boolean;
  sort_order: number;
  default_make: string | null;
  default_model: string | null;
  archived_at: string | null;
};

export const EQUIPMENT_TYPES_KEY = ["equipment-types"] as const;

const db = () => supabase as unknown as SupabaseClient;

/** Every type, archived included; [] before the table exists. */
export async function loadEquipmentTypes(
  client: SupabaseClient = db(),
): Promise<EquipmentTypeRow[]> {
  const full = await client
    .from("equipment_types")
    .select("key, label, active, sort_order, default_make, default_model, archived_at")
    .order("sort_order");
  if (!full.error) return (full.data ?? []) as EquipmentTypeRow[];
  // Before 20261031120000 there are no defaults or archive.
  if ((full.error as { code?: string }).code === "42703") {
    const older = await client
      .from("equipment_types")
      .select("key, label, active, sort_order")
      .order("sort_order");
    if (!older.error)
      return ((older.data ?? []) as EquipmentTypeRow[]).map((t) => ({
        ...t,
        default_make: null,
        default_model: null,
        archived_at: null,
      }));
  }
  if (isMissingSchema(full.error)) return [];
  throw full.error;
}

export type EquipmentTypeAction = "add" | "edit" | "archive" | "restore";

export async function saveEquipmentType(
  action: EquipmentTypeAction,
  type: { key?: string; label?: string; default_make?: string; default_model?: string },
  client: SupabaseClient = db(),
): Promise<string> {
  const { data, error } = await client.rpc(
    "equipment_type_save" as never,
    { _action: action, _type: type, _note: null } as never,
  );
  if (error) throw error;
  return String(data ?? "");
}

/**
 * The register's type picker: the managed list (Settings › Dropdown options)
 * or the built-in eight, plus every type added here, minus archived ones.
 */
export function mergeTypeOptions(
  managed: readonly ManagedOption[],
  rows: readonly EquipmentTypeRow[],
): ManagedOption[] {
  const archived = new Set(rows.filter((r) => r.archived_at).map((r) => r.key));
  const out = managed.filter((o) => !archived.has(o.key));
  const seen = new Set(out.map((o) => o.key));
  for (const r of rows) {
    if (r.archived_at || seen.has(r.key)) continue;
    out.push({ key: r.key, label: r.label });
  }
  return out;
}

const BUILT_IN = optionsFrom(EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABEL);

export function useEquipmentTypes() {
  return useQuery({ queryKey: EQUIPMENT_TYPES_KEY, queryFn: () => loadEquipmentTypes() });
}

/** Options for a register type picker, with each type's default make/model. */
export function useRegisterTypeOptions() {
  const rows = useEquipmentTypes().data ?? [];
  const managed = useManagedOptions("equipment_type", BUILT_IN);
  return useMemo(() => {
    const options = mergeTypeOptions(managed.options, rows);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return {
      options,
      label: (key: string | null | undefined) =>
        key ? (byKey.get(key)?.label ?? managed.label(key)) : "—",
      defaults: (key: string) => ({
        make: byKey.get(key)?.default_make ?? null,
        model: byKey.get(key)?.default_model ?? null,
      }),
    };
  }, [managed, rows]);
}
