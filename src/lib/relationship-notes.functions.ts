/**
 * Relationship note parsing.
 *
 * One of the few sanctioned AI writes: it structures a rep's own words about
 * their own contact into managed categories. It never drafts anything
 * outbound, and the parse is returned as a *proposal* the rep edits before it
 * is saved — the raw text is always kept.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export interface ParsedRelationshipFact {
  category_key: string;
  value: string;
}

export interface RelationshipParseResult {
  facts: ParsedRelationshipFact[];
  birthday_month: number | null;
  birthday_day: number | null;
  /** True while View As is active: preview only, never save. */
  read_only: boolean;
}

const input = z.object({
  text: z.string().trim().min(3).max(6000),
  /** Existing values so appended text merges instead of replacing. */
  existing: z
    .array(z.object({ category_key: z.string(), value: z.string() }))
    .max(50)
    .default([]),
});

export const parseRelationshipNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data, context }): Promise<RelationshipParseResult> => {
    const { complete, safeJson } = await import("./ai.server");
    const { resolveAssistantScope, logAssistantEvent, untrusted, UNTRUSTED_PREAMBLE } =
      await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    const { data: cats } = await context.supabase
      .from("option_list_values")
      .select("key, label, option_lists!inner(key)")
      .eq("option_lists.key", "relationship_note_category")
      .eq("active", true)
      .order("sort_order");

    const categories = (cats ?? []).map((c) => ({
      key: c.key as string,
      label: c.label as string,
    }));
    if (categories.length === 0) {
      throw new Error("No relationship categories are configured. Add them in Admin.");
    }

    const system = [
      "You organise a salesperson's free-text note about ONE business contact into fixed categories.",
      'Return ONLY JSON: { "facts": [ { "category_key": string, "value": string } ], "birthday_month": number|null, "birthday_day": number|null }.',
      `category_key MUST be one of: ${categories.map((c) => c.key).join(", ")}.`,
      "Use the rep's own words. Never invent a detail that is not in the note.",
      "Merge with EXISTING values: keep what is still true, add the new detail, and only change a value when the new text contradicts it. Return the full merged value per category.",
      "Values are short human-readable phrases, comma-separated when there are several (e.g. 'Cigars (Padron 1964), Golf (Winged Foot)').",
      "Omit a category entirely when there is nothing for it.",
      "birthday_month/birthday_day are numbers only when a birthday date is clearly stated, otherwise null.",
      "",
      UNTRUSTED_PREAMBLE,
    ].join("\n");

    const user = [
      "CATEGORIES (key|label):",
      categories.map((c) => `${c.key}|${c.label}`).join("\n"),
      "",
      "EXISTING VALUES (key|value):",
      data.existing.length
        ? untrusted(data.existing.map((e) => `${e.category_key}|${e.value}`).join("\n"))
        : "(none)",
      "",
      "NOTE FROM THE REP:",
      untrusted(data.text),
    ].join("\n");

    const raw = await complete(system, user, true, "extraction", { feature: "relationship_notes" });
    const parsed = safeJson<{
      facts?: { category_key?: string; value?: string }[];
      birthday_month?: number | null;
      birthday_day?: number | null;
    }>(raw);
    if (!parsed) throw new Error("Could not read the assistant's response. Try again.");

    // One value per category: when the model returns several entries for a
    // category, join them rather than dropping the extras.
    const allowed = new Set(categories.map((c) => c.key));
    const merged = new Map<string, string>();
    for (const f of parsed.facts ?? []) {
      const key = (f.category_key ?? "").trim();
      const value = (f.value ?? "").trim();
      if (!allowed.has(key) || !value) continue;
      const prev = merged.get(key);
      merged.set(key, prev ? `${prev}, ${value}` : value);
    }
    const facts: ParsedRelationshipFact[] = [...merged].map(([category_key, value]) => ({
      category_key,
      value: value.slice(0, 500),
    }));

    const month = Number(parsed.birthday_month);
    const day = Number(parsed.birthday_day);
    const validBday =
      Number.isInteger(month) &&
      month >= 1 &&
      month <= 12 &&
      Number.isInteger(day) &&
      day >= 1 &&
      day <= 31;

    await logAssistantEvent(scope, {
      feature: "relationship_note_parse",
      question: data.text,
      retrieved: { categories: categories.length, existing: data.existing.length },
      responsePreview: facts.map((f) => `${f.category_key}: ${f.value}`).join(" · "),
      model: "google/gemini-3.6-flash",
    });

    return {
      facts,
      birthday_month: validBday ? month : null,
      birthday_day: validBday ? day : null,
      read_only: scope.impersonating,
    };
  });
