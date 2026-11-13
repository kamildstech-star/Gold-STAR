import { supabase } from "@/integrations/supabase/client";

export type LabelScope =
  "lead" | "job" | "contact" | "photo" | "project" | "account" | "opportunity";

export type Label = {
  id: string;
  name: string;
  color: string;
  scopes: LabelScope[];
  sort_order: number;
  archived_at: string | null;
};

/**
 * Label palette. Each entry is a tinted background paired with darker text of
 * the same hue — never a saturated fill with white text. Admin-selectable per
 * label; the stored value is the background hex.
 */
export const LABEL_PALETTE = [
  { name: "Yellow", bg: "#FFE9A8", fg: "#7A5B00", token: "yellow" },
  { name: "Green", bg: "#CFF3E1", fg: "#0A6B45", token: "green" },
  { name: "Blue", bg: "#D6E7FF", fg: "#12467B", token: "blue" },
  { name: "Purple", bg: "#E6DBFF", fg: "#4B2E83", token: "purple" },
  { name: "Pink", bg: "#FFD9E6", fg: "#8C1D48", token: "pink" },
  { name: "Teal", bg: "#CFF0F2", fg: "#0B5A63", token: "teal" },
  { name: "Orange", bg: "#FFDFC7", fg: "#8A3D06", token: "orange" },
  { name: "Red", bg: "#FFD9D6", fg: "#8C1D18", token: "red" },
  { name: "Gray", bg: "#E6E8EB", fg: "#3F4550", token: "grey" },
] as const;

/** Background hexes, in palette order — what the swatch pickers offer. */
export const LABEL_COLORS = LABEL_PALETTE.map((p) => p.bg);

export async function fetchLabels(scope?: LabelScope): Promise<Label[]> {
  let q = supabase
    .from("tags")
    .select("id, name, color, scopes, sort_order, archived_at")
    .is("archived_at", null)
    .order("sort_order")
    .order("name");
  if (scope) q = q.contains("scopes", [scope]);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as Label[];
}

/** Join-table config so one picker serves every entity. */
export const LINK_TABLES = {
  lead: { table: "lead_tags", key: "lead_id" },
  account: { table: "account_tags", key: "account_id" },
  opportunity: { table: "account_tags", key: "account_id" },
  contact: { table: "contact_tags", key: "contact_id" },
  job: { table: "job_tags", key: "job_id" },
} as const;

export type LinkableScope = keyof typeof LINK_TABLES;

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loosely typed handle: the join tables share a shape but not a generated union type. */
const sb = supabase as unknown as { from: (table: string) => any };

export async function fetchLabelIdsFor(scope: LinkableScope, recordId: string): Promise<string[]> {
  const cfg = LINK_TABLES[scope];
  const { data, error } = await sb.from(cfg.table).select("tag_id").eq(cfg.key, recordId);
  if (error) throw error;
  return (data ?? []).map((r: { tag_id: string }) => r.tag_id) as string[];
}

/** Fetch labels for many records at once, keyed by record id. */
export async function fetchLabelMap(
  scope: LinkableScope,
  recordIds: string[],
): Promise<Record<string, Label[]>> {
  if (recordIds.length === 0) return {};
  const cfg = LINK_TABLES[scope];
  const { data, error } = await sb
    .from(cfg.table)
    .select(`${cfg.key}, tag:tag_id(id, name, color, scopes, sort_order, archived_at)`)
    .in(cfg.key, recordIds);
  if (error) throw error;
  const out: Record<string, Label[]> = {};
  for (const row of (data ?? []) as unknown as Array<Record<string, unknown>>) {
    const id = row[cfg.key] as string;
    const tag = row.tag as Label | null;
    if (!tag) continue;
    (out[id] ??= []).push(tag);
  }
  for (const list of Object.values(out)) {
    list.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  return out;
}

export async function setLabelsFor(
  scope: LinkableScope,
  recordId: string,
  labelIds: string[],
  currentIds: string[],
) {
  const cfg = LINK_TABLES[scope];
  const toAdd = labelIds.filter((id) => !currentIds.includes(id));
  const toRemove = currentIds.filter((id) => !labelIds.includes(id));
  if (toRemove.length) {
    const { error } = await sb
      .from(cfg.table)
      .delete()
      .eq(cfg.key, recordId)
      .in("tag_id", toRemove);
    if (error) throw error;
  }
  if (toAdd.length) {
    const { error } = await sb
      .from(cfg.table)
      .insert(toAdd.map((tag_id) => ({ [cfg.key]: recordId, tag_id })));
    if (error) throw error;
  }
}

export async function fetchLabelCreationSetting(): Promise<"everyone" | "privileged"> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "labels")
    .maybeSingle();
  const v = (data?.value as { who_can_create?: string } | null)?.who_can_create;
  return v === "everyone" ? "everyone" : "privileged";
}

export async function setLabelCreationSetting(value: "everyone" | "privileged") {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "labels", value: { who_can_create: value } }, { onConflict: "key" });
  if (error) throw error;
}

/**
 * Background + text pair for a pill. Palette colours resolve to CSS variables
 * so the same label reads correctly in both themes — pale tint on white, deep
 * tint with lifted text on the dark ground. Anything legacy or custom is mixed
 * against the current surface with `color-mix`, which is likewise theme-aware.
 */
export function pillStyle(hex: string): { backgroundColor: string; color: string } {
  const norm = (hex ?? "").trim().toUpperCase();
  const hit = LABEL_PALETTE.find((p) => p.bg.toUpperCase() === norm);
  if (hit) {
    return {
      backgroundColor: `var(--label-${hit.token})`,
      color: `var(--label-${hit.token}-fg)`,
    };
  }

  const h = norm.replace("#", "");
  if (h.length !== 6)
    return { backgroundColor: "var(--label-grey)", color: "var(--label-grey-fg)" };
  return {
    backgroundColor: `color-mix(in srgb, ${norm} 20%, var(--card))`,
    color: `color-mix(in srgb, ${norm} 65%, var(--foreground))`,
  };
}

/** Legacy helper — kept so older call sites keep compiling. */
export function pillTextColor(hex: string): string {
  return pillStyle(hex).color;
}
