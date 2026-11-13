/**
 * Reading the "House Account" label for a whole book at once.
 *
 * Mark: "House accounts belong to the company rather than a rep."
 *
 * `src/lib/account-ownership.ts` is the rule; this is the one read that lets a
 * screen ask it. The rule needs label names, and the three surfaces still
 * missing it — the pipeline's Mine scope, the morning brief and the weekly
 * sales report — reason over every account a viewer can see, not a page of
 * them.
 *
 * WHY NOT `fetchLabelMap`
 * -----------------------
 * `fetchLabelMap("account", ids)` asks "what is on these records?", and
 * PostgREST puts the id list in the query string. That is right for a board of
 * forty cards and wrong for a report over the whole book — `weekly-sales.ts`
 * already caps an `in (…)` at 150 ids for exactly this reason. So this asks
 * the question the other way round: find the tag, then read its links. Two
 * small reads whatever the size of the book, because house accounts are a
 * minority of it.
 *
 * The label is matched by `isHouseAccount`, not by an equality test, so
 * "House-Account" and "house account" are the same label here as they are
 * everywhere else. There is one matcher, and this is not a second one.
 *
 * RLS still decides what comes back. A viewer who cannot see the account
 * cannot see its label row either, and both reads go through their own client.
 */

import { supabase } from "@/integrations/supabase/client";
import { isHouseAccount } from "@/lib/account-clocks";
import { LINK_TABLES } from "@/lib/labels";

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Loosely typed handle: the join tables share a shape but not a generated union type. */
const sb = supabase as unknown as { from: (table: string) => any };

/**
 * Account id → its house label name, for every account carrying one.
 *
 * Shaped like `fetchLabelMap`'s result on purpose: a caller writes
 * `labels: houseLabels[a.id] ?? []` and hands that to `accountOwnership`,
 * which is the same line `goals.ts` already writes. An account that is not the
 * company's is simply absent, which reads as "no house label" — the only thing
 * the ownership rule asks about.
 */
export async function fetchHouseAccountLabels(): Promise<Record<string, string[]>> {
  const { data: tags, error: tagError } = await sb.from("tags").select("id, name");
  if (tagError) throw tagError;

  const houseTagIds = ((tags ?? []) as { id: string; name: string }[])
    .filter((t) => isHouseAccount({ labels: [t.name] }))
    .map((t) => t.id);
  if (houseTagIds.length === 0) return {};

  const cfg = LINK_TABLES.account;
  const { data, error } = await sb
    .from(cfg.table)
    .select(`${cfg.key}, tag_id`)
    .in("tag_id", houseTagIds);
  if (error) throw error;

  const names = new Map(
    ((tags ?? []) as { id: string; name: string }[]).map((t) => [t.id, t.name]),
  );
  const out: Record<string, string[]> = {};
  for (const row of (data ?? []) as Record<string, string>[]) {
    const accountId = row[cfg.key];
    const name = names.get(row.tag_id);
    if (!accountId || !name) continue;
    (out[accountId] ??= []).push(name);
  }
  return out;
}

/**
 * The same read, with the failure a report wants.
 *
 * A label read that fails must not blank out a rep's week or a Sales Head's
 * brief, so an empty map means "nothing is known to be the company's" and the
 * screen falls back to the behaviour it had before this rule existed. Same
 * choice `goals.ts` made, for the same reason.
 */
export async function fetchHouseAccountLabelsOrNone(): Promise<Record<string, string[]>> {
  return fetchHouseAccountLabels().catch(() => ({}) as Record<string, string[]>);
}
