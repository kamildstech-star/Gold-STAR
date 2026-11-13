import { supabase } from "@/integrations/supabase/client";

/**
 * Standing notes follow the customer or the property, not the job.
 * One source of truth each — the job banners read them live, so editing
 * from a job banner updates every other job that shows the same note.
 */

export type StandingNoteKind = "general" | "discount" | "billing" | "access";

export const STANDING_NOTE_KINDS: { value: StandingNoteKind; label: string }[] = [
  { value: "general", label: "General" },
  { value: "discount", label: "Discount / pricing arrangement" },
  { value: "billing", label: "Billing instruction" },
  { value: "access", label: "Site access" },
];

export type AccountStandingNote = {
  accountId: string;
  accountName: string;
  note: string;
  kind: StandingNoteKind;
  /** Pinned at the top of every job for the account (5 Nov, T4). */
  urgent: boolean;
};

export type PropertyNote = {
  id: string;
  address_key: string;
  address: string;
  note: string;
  updated_at: string;
  /** Pinned at the top of every job at the address (5 Nov, T4). */
  urgent: boolean;
};

/**
 * Street addresses arrive typed, geocoded, abbreviated and punctuated a dozen
 * ways. Fold to a comparable key so "12 Main St." and "12 main street" are the
 * same property. Deliberately conservative: it only lowercases, strips
 * punctuation, expands the common street-type abbreviations and collapses
 * whitespace.
 */
const STREET_WORDS: Record<string, string> = {
  st: "street",
  str: "street",
  ave: "avenue",
  av: "avenue",
  rd: "road",
  blvd: "boulevard",
  dr: "drive",
  ln: "lane",
  ct: "court",
  pl: "place",
  ter: "terrace",
  pkwy: "parkway",
  hwy: "highway",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  apt: "apartment",
  ste: "suite",
};

export function addressKey(address: string | null | undefined): string | null {
  if (!address) return null;
  const cleaned = address
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_WORDS[w] ?? w)
    .join(" ")
    .trim();
  return cleaned || null;
}

export async function fetchAccountStandingNote(
  accountId: string | null,
): Promise<AccountStandingNote | null> {
  if (!accountId) return null;
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, standing_note, standing_note_kind, standing_note_urgent")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.standing_note) return null;
  return {
    accountId: data.id,
    accountName: data.name,
    note: data.standing_note,
    kind: (data.standing_note_kind as StandingNoteKind) ?? "general",
    urgent: data.standing_note_urgent ?? false,
  };
}

export async function saveAccountStandingNote(
  accountId: string,
  note: string | null,
  kind: StandingNoteKind,
  /** Left out by callers that don't show the checkbox, so they keep it. */
  urgent?: boolean,
) {
  const { error } = await supabase
    .from("accounts")
    .update({
      standing_note: note,
      standing_note_kind: kind,
      ...(urgent === undefined && note ? {} : { standing_note_urgent: !!note && !!urgent }),
    })
    .eq("id", accountId);
  if (error) throw error;
}

export async function fetchPropertyNote(
  address: string | null | undefined,
): Promise<PropertyNote | null> {
  const key = addressKey(address);
  if (!key) return null;
  const { data, error } = await supabase
    .from("property_notes")
    .select("id, address_key, address, note, updated_at, urgent")
    .eq("address_key", key)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, urgent: data.urgent ?? false } : null;
}

export async function savePropertyNote(opts: {
  address: string;
  note: string | null;
  userId: string | null;
  locationId?: string | null;
  urgent?: boolean;
}) {
  const key = addressKey(opts.address);
  if (!key) throw new Error("A street address is required for a property note.");

  if (!opts.note) {
    const { error } = await supabase.from("property_notes").delete().eq("address_key", key);
    if (error) throw error;
    return;
  }

  const { error } = await supabase.from("property_notes").upsert(
    {
      address_key: key,
      address: opts.address,
      note: opts.note,
      ...(opts.urgent === undefined ? {} : { urgent: opts.urgent }),
      location_id: opts.locationId ?? null,
      updated_by: opts.userId,
      created_by: opts.userId,
    },
    { onConflict: "address_key" },
  );
  if (error) throw error;
}
