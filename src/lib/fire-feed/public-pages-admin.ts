/**
 * The admin side of public incident pages: the rows of fire_feed_sources
 * with kind 'public_page', read and written with the admin's own client so
 * RLS (is_privileged, migration 20261011140000) decides.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { checkPublicUrl } from "@/lib/public-url";

import {
  isGovernmentHost,
  PUBLIC_PAGE_FIELDS,
  publicPageConfigSchema,
  type PublicPageConfig,
  type PublicPageField,
} from "./public-page";

/* Not in the generated types until Lovable regenerates them after
   migration 20261011140000 is applied. */
const db = () => supabase as unknown as SupabaseClient;

export interface PublicPageSource {
  id: string;
  label: string;
  url: string;
  config: Record<string, unknown>;
  area_id: string | null;
  poll_minutes: number;
  enabled: boolean;
  last_fetched_at: string | null;
  last_status: number | null;
  last_error: string | null;
}

export async function loadPublicPages(): Promise<PublicPageSource[] | null> {
  const { data, error } = await db()
    .from("fire_feed_sources")
    .select(
      "id, label, url, config, area_id, poll_minutes, enabled, last_fetched_at, last_status, last_error",
    )
    .eq("kind", "public_page")
    .order("created_at");
  if (error) {
    const code = (error as { code?: string }).code;
    if (
      code === "42P01" ||
      code === "PGRST205" ||
      /does not exist|schema cache/i.test(error.message)
    )
      return null;
    throw error;
  }
  return (data ?? []) as PublicPageSource[];
}

export interface PublicPageForm {
  label: string;
  url: string;
  preset: "html_table" | "json" | "rss";
  poll: string;
  governmentAck: boolean;
  fireRowsOnly: boolean;
  tableIndex: string;
  /** The table's HTML id ("GridView2"); wins over the number when given. */
  tableId: string;
  itemsPath: string;
  /** Statuses to drop, comma-separated ("Completed, Closed"). Blank keeps every row. */
  excludeStatuses: string;
  /** Column header / number (table) or field path (JSON), per field. */
  fields: Partial<Record<PublicPageField | "lat" | "lon", string>>;
}

export const EMPTY_FORM: PublicPageForm = {
  label: "",
  url: "",
  preset: "html_table",
  poll: "3",
  governmentAck: false,
  fireRowsOnly: true,
  tableIndex: "1",
  tableId: "",
  itemsPath: "",
  excludeStatuses: "",
  fields: {},
};

/** The config jsonb the form describes, validated the way the source will read it. */
export function configFromForm(f: PublicPageForm): PublicPageConfig {
  const fields = Object.fromEntries(
    Object.entries(f.fields)
      .map(([k, v]) => [k, (v ?? "").trim()])
      .filter(([, v]) => v),
  ) as Record<string, string>;
  const cfg: PublicPageConfig = {
    preset: f.preset,
    fire_rows_only: f.fireRowsOnly,
    ...(f.governmentAck ? { government_ack: true } : {}),
  };
  const excluded = f.excludeStatuses
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (excluded.length) cfg.exclude_statuses = excluded;
  if (f.preset === "html_table") {
    const index = f.tableIndex.trim() ? Number(f.tableIndex) : 1;
    if (!Number.isInteger(index) || index < 1 || index > 50)
      throw new Error("Table number is 1 to 50 (1 = the first table on the page).");
    const columns = Object.fromEntries(
      PUBLIC_PAGE_FIELDS.filter((k) => fields[k]).map((k) => [k, fields[k]]),
    );
    const id = f.tableId.trim();
    cfg.table = { index, ...(id ? { id } : {}), columns };
  } else if (f.preset === "json") {
    cfg.json = { items_path: f.itemsPath.trim() || undefined, fields };
  }
  const parsed = publicPageConfigSchema.safeParse(cfg);
  if (!parsed.success) throw new Error("Those reading settings are not valid.");
  return parsed.data;
}

/** The form's URL, refused if it is not public; and whether it needs the government confirmation. */
export function checkPageUrl(raw: string): { url: string; needsAck: boolean; insecure: boolean } {
  const c = checkPublicUrl(raw);
  if (!c.ok) throw new Error(`${c.reason}.`);
  return {
    url: c.url.toString(),
    needsAck: !isGovernmentHost(c.url.hostname),
    // Rockland's Firewatch is served over plain http only. Allowed for a
    // confirmed government page, and said so on screen.
    insecure: c.url.protocol === "http:",
  };
}

export async function addPublicPage(f: PublicPageForm): Promise<void> {
  const label = f.label.trim();
  if (!label) throw new Error("Give the page a name (the county or department).");
  const { url, needsAck } = checkPageUrl(f.url);
  if (needsAck && !f.governmentAck) {
    throw new Error(
      "This address is not a .gov or .us site. Tick the box to confirm it is a public government page, or leave it out.",
    );
  }
  const poll = Math.round(Number(f.poll || "3"));
  if (!Number.isFinite(poll) || poll < 2 || poll > 1440)
    throw new Error("Check every 2 to 1440 minutes — never more often than every 2.");
  const { error } = await db()
    .from("fire_feed_sources")
    .insert({ kind: "public_page", label, url, poll_minutes: poll, config: configFromForm(f) });
  if (error) {
    if ((error as { code?: string }).code === "23505")
      throw new Error("That page is already on the list.");
    throw error;
  }
}

export async function updatePublicPage(
  id: string,
  patch: Partial<Pick<PublicPageSource, "label" | "enabled" | "poll_minutes" | "config">>,
): Promise<void> {
  const { error } = await db()
    .from("fire_feed_sources")
    .update(patch)
    .eq("id", id)
    .eq("kind", "public_page");
  if (error) throw error;
}

export async function deletePublicPage(id: string): Promise<void> {
  const { error } = await db()
    .from("fire_feed_sources")
    .delete()
    .eq("id", id)
    .eq("kind", "public_page");
  if (error) throw error;
}
