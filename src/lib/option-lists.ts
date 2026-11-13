import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Managed dropdown options.
 *
 * The client asked for every fixed set of choices in the app to be
 * administrable rather than hardcoded. Where a Postgres enum already backs a
 * column (job status, contact role, equipment type) the enum stays as the
 * storage type and this list drives the *labels, ordering and active state*
 * that users actually see. Where there is no enum (job type, loss
 * description, referral source type) this list is the source of truth.
 */

export const OPTION_LIST_KEYS = [
  "job_type",
  "insurance_kind",
  "loss_type",
  "loss_description",
  "job_status",
  "referral_source_type",
  "contact_decision_role",
  "contact_position",
  "equipment_type",
  "reported_source",
  "job_contact_role",
  "competitor",
  "tpa",
  "chase_decline_reason",
  "lead_source",
] as const;

export type OptionListKey = (typeof OPTION_LIST_KEYS)[number];

export interface OptionValue {
  id: string;
  key: string;
  label: string;
  sort_order: number;
  active: boolean;
  is_default: boolean;
  requires_detail: boolean;
  location_id: string | null;
  metadata: Record<string, unknown> | null;
}

export interface OptionListRow {
  id: string;
  key: string;
  label: string;
  description: string | null;
  backed_by_enum: string | null;
  allow_location_scope: boolean;
}

export async function fetchOptionValues(
  listKey: string,
  opts: { locationId?: string | null; includeInactive?: boolean } = {},
): Promise<OptionValue[]> {
  const { data, error } = await supabase
    .from("option_list_values")
    .select(
      "id, key, label, sort_order, active, is_default, requires_detail, location_id, metadata, option_lists!inner(key)",
    )
    .eq("option_lists.key", listKey)
    .order("sort_order");
  if (error) throw error;
  const rows = (data ?? []) as unknown as OptionValue[];
  return rows.filter((r) => {
    if (!opts.includeInactive && !r.active) return false;
    if (r.location_id && opts.locationId && r.location_id !== opts.locationId) return false;
    if (r.location_id && !opts.locationId) return false;
    return true;
  });
}

export function useOptionList(
  listKey: OptionListKey | string,
  opts: { locationId?: string | null; includeInactive?: boolean } = {},
) {
  const q = useQuery({
    queryKey: ["option-list", listKey, opts.locationId ?? null, !!opts.includeInactive],
    queryFn: () => fetchOptionValues(listKey, opts),
    staleTime: 5 * 60_000,
  });
  return { options: q.data ?? [], isLoading: q.isLoading, error: q.error };
}

export function optionLabel(options: OptionValue[], key: string | null | undefined): string {
  if (!key) return "—";
  return options.find((o) => o.key === key)?.label ?? key;
}

export function defaultOptionKey(options: OptionValue[]): string {
  return options.find((o) => o.is_default)?.key ?? options[0]?.key ?? "";
}

/** Map managed options onto the shape <DetailSelect> expects. */
export function toDetailOptions(options: OptionValue[]) {
  return options.map((o) => ({
    value: o.key,
    label: o.label,
    requiresDetail: o.requires_detail,
  }));
}
