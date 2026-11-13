/**
 * How much of a deal card is drawn.
 *
 * Mark: "there needs to be a full detail, current view, and small detail that
 * shrinks the cards and the things inside to show everything in a smaller view
 * easily to see many cards at once."
 *
 * Three settings rather than a slider, because there are three real answers: I
 * am reading this board, I am working this board, or I am looking for one card
 * among forty. The middle one is exactly the card as it is today, so nobody who
 * never touches this notices it exists.
 *
 * Stored per person in `user_view_prefs`, the same table and shape the folded
 * stages use, so a rep's board looks the way they left it on the next machine.
 */
import * as React from "react";

import { supabase } from "@/integrations/supabase/client";

export const CARD_DENSITIES = ["full", "normal", "compact"] as const;
export type CardDensity = (typeof CARD_DENSITIES)[number];

export const CARD_DENSITY_LABEL: Record<CardDensity, string> = {
  full: "Full",
  normal: "Normal",
  compact: "Compact",
};

export const CARD_DENSITY_HINT: Record<CardDensity, string> = {
  full: "Everything the card knows, including contacts and time in stage",
  normal: "The usual card",
  compact: "Name, value and owner — for scanning a long column",
};

export const CARD_DENSITY_SCOPE = "pipeline_card_density";

/**
 * The Active Clients health board keeps its own row in the same table.
 *
 * The two boards are read for different reasons -- a rep works the pipeline
 * card by card and scans the health board for the account that has gone quiet
 * -- so someone who wants forty health cards on screen at once does not
 * thereby want forty deal cards.
 */
export const ACTIVE_CLIENTS_CARD_DENSITY_SCOPE = "active_clients_card_density";

export const DEFAULT_CARD_DENSITY: CardDensity = "normal";

/** Anything that is not one of the three is the middle one. */
export function parseCardDensity(raw: string | null | undefined): CardDensity {
  return (CARD_DENSITIES as readonly string[]).includes(raw ?? "")
    ? (raw as CardDensity)
    : DEFAULT_CARD_DENSITY;
}

export async function loadCardDensity(
  userId: string,
  scope: string = CARD_DENSITY_SCOPE,
): Promise<CardDensity> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", scope)
    .maybeSingle();
  return parseCardDensity(data?.view_mode);
}

export async function saveCardDensity(
  userId: string,
  density: CardDensity,
  scope: string = CARD_DENSITY_SCOPE,
): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope,
      view_mode: density,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

/**
 * The person's density, read once and written on every change.
 *
 * A failed read leaves the default rather than an error: a preference nobody
 * can load is a preference, not an outage. A failed write is equally quiet,
 * because the board in front of them has already changed and telling them it
 * did not stick on the server helps nobody mid-scroll.
 */
export function useCardDensity(
  userId: string | null | undefined,
  persistEnabled = true,
  scope: string = CARD_DENSITY_SCOPE,
): { density: CardDensity; setDensity: (d: CardDensity) => void } {
  const [density, setLocal] = React.useState<CardDensity>(DEFAULT_CARD_DENSITY);

  React.useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    loadCardDensity(userId, scope)
      .then((d) => {
        if (!cancelled) setLocal(d);
      })
      .catch(() => {
        /* the default is a fine answer */
      });
    return () => {
      cancelled = true;
    };
  }, [userId, scope]);

  const setDensity = React.useCallback(
    (d: CardDensity) => {
      setLocal(d);
      if (!userId || !persistEnabled) return;
      void saveCardDensity(userId, d, scope).catch(() => {
        /* see above */
      });
    },
    [userId, persistEnabled, scope],
  );

  return { density, setDensity };
}
