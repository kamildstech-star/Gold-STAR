import { supabase } from "@/integrations/supabase/client";

/**
 * Named groupings of offices, used to organise an office picker.
 *
 * Deliberately NOT public.regions: regions are an access boundary
 * (public.is_regional_for reads location_regions and gates job/document RLS),
 * so grouping two offices together for a dropdown would also hand a regional
 * manager the other office's data. This concept is presentation only.
 *
 * Many-to-many, because an office belongs to a brand and a territory at once —
 * the same reason locations.region_id had to grow into location_regions.
 */
export type OfficeGroup = {
  id: string;
  name: string;
  description: string | null;
  sort_order: number;
};

/**
 * The office fields a picker needs to label a choice, plus the ones an estimate
 * or invoice snapshots when the choice is made.
 */
export type OfficeOption = {
  id: string;
  code: string;
  name: string;
  legal_entity_name: string | null;
  address: string;
  locality: string | null;
  region: string;
  postal_code: string | null;
  office_phone: string | null;
  office_email: string | null;
};

const OFFICE_FIELDS =
  "id, code, name, legal_entity_name, address, locality, region, postal_code, office_phone, office_email";

export const officeGroupKeys = {
  groups: ["office-groups"] as const,
  members: ["office-group-members"] as const,
  offices: ["office-group-offices"] as const,
};

export type OfficeGroupMember = { group_id: string; location_id: string };

export async function loadOfficeGroups(): Promise<OfficeGroup[]> {
  const { data, error } = await supabase
    .from("location_groups")
    .select("id, name, description, sort_order")
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return data ?? [];
}

export async function loadOfficeGroupMembers(): Promise<OfficeGroupMember[]> {
  const { data, error } = await supabase
    .from("location_group_members")
    .select("group_id, location_id");
  if (error) throw error;
  return data ?? [];
}

export async function loadOfficeOptions(includeInactive = false): Promise<OfficeOption[]> {
  let q = supabase.from("locations").select(OFFICE_FIELDS).order("code");
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as OfficeOption[];
}

/** One heading in the picker. `id` is null for the "Other offices" bucket. */
export type OfficeGroupSection = {
  id: string | null;
  label: string;
  offices: OfficeOption[];
};

export const UNGROUPED_LABEL = "Other offices";

/**
 * Offices arranged under their group headings. An office in two groups appears
 * under both — that is the point of the grouping, not a bug. Offices in no
 * group land under a plain heading rather than vanishing from the picker.
 */
export function sectionOffices(
  offices: OfficeOption[],
  groups: OfficeGroup[],
  members: OfficeGroupMember[],
): OfficeGroupSection[] {
  const byId = new Map(offices.map((o) => [o.id, o]));
  const grouped = new Set<string>();
  const sections: OfficeGroupSection[] = [];

  for (const g of groups) {
    const inGroup = members
      .filter((m) => m.group_id === g.id)
      .map((m) => byId.get(m.location_id))
      .filter((o): o is OfficeOption => !!o)
      .sort((a, b) => a.code.localeCompare(b.code));
    for (const o of inGroup) grouped.add(o.id);
    if (inGroup.length) sections.push({ id: g.id, label: g.name, offices: inGroup });
  }

  const rest = offices.filter((o) => !grouped.has(o.id));
  if (rest.length) sections.push({ id: null, label: UNGROUPED_LABEL, offices: rest });
  return sections;
}

export function officeOptionLabel(o: OfficeOption): string {
  const place = [o.locality, o.region].filter(Boolean).join(", ");
  const name = o.legal_entity_name?.trim() || o.name;
  return place ? `${name} · ${place}` : name;
}

/**
 * The office block an estimate or invoice stores on itself. Documents snapshot
 * the office so a printed estimate does not silently change when someone edits
 * the office later — so picking a new office has to rewrite the snapshot, not
 * just the foreign key.
 */
export function officeSnapshot(o: OfficeOption) {
  return {
    location_id: o.id,
    office_name: o.name,
    office_phone: o.office_phone,
    office_email: o.office_email,
    office_address:
      [o.address, o.locality, o.region, o.postal_code].filter(Boolean).join(", ") || null,
  };
}
