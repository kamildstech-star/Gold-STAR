/**
 * Stored translations. Work orders are translated on save and read back
 * from the database, so a crew phone in a basement never waits on an API.
 */
import { supabase } from "@/integrations/supabase/client";
import { sourceHash } from "./source-hash";

export { sourceHash };

export type TranslatableEntity = "job" | "job_note" | "quote" | "message";

export interface StoredTranslation {
  id: string;
  text: string;
  source: "machine" | "human";
  source_text: string | null;
  source_hash: string | null;
  updated_at: string;
}

/** True when the stored translation was made from exactly this English text. */
export function translationMatches(
  stored: Pick<StoredTranslation, "source_text" | "source_hash"> | null,
  text: string,
): boolean {
  if (!stored) return false;
  if (stored.source_hash) return stored.source_hash === sourceHash(text);
  // Rows written before hashing fall back to an exact source comparison.
  return stored.source_text === text;
}

export async function getTranslation(
  entityType: TranslatableEntity,
  entityId: string,
  field: string,
  lang = "es",
): Promise<StoredTranslation | null> {
  const { data, error } = await supabase
    .from("translations")
    .select("id, text, source, source_text, source_hash, updated_at")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .eq("field", field)
    .eq("lang", lang)
    .maybeSingle();
  if (error) throw error;
  return (data as StoredTranslation | null) ?? null;
}

/** A bilingual supervisor's correction wins over the machine output. */
export async function saveCorrection(args: {
  entityType: TranslatableEntity;
  entityId: string;
  field: string;
  lang?: string;
  text: string;
  sourceText: string;
  userId: string;
}): Promise<void> {
  const { error } = await supabase.from("translations").upsert(
    {
      entity_type: args.entityType,
      entity_id: args.entityId,
      field: args.field,
      lang: args.lang ?? "es",
      text: args.text,
      source_text: args.sourceText,
      source_hash: sourceHash(args.sourceText),
      source: "human",
      corrected_by: args.userId,
      corrected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "entity_type,entity_id,field,lang" },
  );
  if (error) throw error;
}

export async function getLanguagePreference(userId: string): Promise<string> {
  const { data } = await supabase
    .from("profiles")
    .select("language")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.language ?? "en";
}

export async function setLanguagePreference(userId: string, language: string): Promise<void> {
  const { error } = await supabase.from("profiles").update({ language }).eq("user_id", userId);
  if (error) throw error;
}
