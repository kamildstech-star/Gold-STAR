/**
 * Which order the reading cards sit in on the drying log.
 *
 * Mark, 2026-09-07: "allow cards to move around". The cards are the points a
 * crew types — Inside and Affected today — and a technician can drag them
 * into the order he walks the property in.
 *
 * Stored per person in `user_view_prefs` (scope `drying_card_order`), the same
 * key-value table the sidebar order and the pipeline view modes already live
 * in, so it follows the person between the tablet and the office and needs no
 * new column. An admin can change or clear a row there without a deploy. The
 * value is a JSON array of point keys; anything that is not one of the points
 * on the form is dropped on read, and a point the saved order does not name is
 * appended in its default place, so a card added later can never be hidden by
 * an order saved before it existed.
 */
import { supabase } from "@/integrations/supabase/client";
import { ENTRY_POINTS, type DryingPoint } from "./drying-log";
import { applyOrder } from "./sidebar-order";

export const DRYING_CARD_ORDER_SCOPE = "drying_card_order";

const KNOWN: ReadonlySet<string> = new Set(ENTRY_POINTS.map((p) => p.key));

/**
 * The saved order as a list of points, or empty for anything that is not one.
 * Never throws: a row an admin edited by hand into something odd reads as "no
 * order saved", which is the default layout, not a broken screen.
 */
export function parseCardOrder(raw: string | null | undefined): DryingPoint[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: DryingPoint[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && KNOWN.has(item) && !out.includes(item as DryingPoint)) {
        out.push(item as DryingPoint);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The cards in the saved order — those it names first, then the rest as they were. */
export function orderCards<T extends { key: DryingPoint }>(cards: T[], saved: DryingPoint[]): T[] {
  return applyOrder(cards, saved, (c) => c.key);
}

export async function loadDryingCardOrder(userId: string): Promise<DryingPoint[]> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", DRYING_CARD_ORDER_SCOPE)
    .maybeSingle();
  return parseCardOrder(data?.view_mode);
}

export async function saveDryingCardOrder(userId: string, order: DryingPoint[]): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope: DRYING_CARD_ORDER_SCOPE,
      view_mode: JSON.stringify(order),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}
