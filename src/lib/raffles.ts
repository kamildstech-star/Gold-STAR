/**
 * Trade show raffles: Tradeshow > Raffles > Contacts and prize draw.
 *
 * A raffle belongs to one show and has its own QR code. Visitors scan it,
 * fill a short form (raffle-public.functions.ts) and are entered once per
 * email. Staff see every entry as a contact, and a manager runs the draw —
 * which happens in the database (draw_raffle_winners, 20261110210000), never
 * in the browser, so nobody can pick a winner by hand.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { browserAppOrigin } from "@/lib/app-origin";
import { supabase as typed } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { Tone } from "@/lib/tone";

/** The raffle tables are newer than the generated types. */
const supabase = typed as unknown as SupabaseClient;

export type RaffleStatus = "draft" | "open" | "closed";
export type WinnerStatus = "drawn" | "notified" | "claimed" | "forfeited";

export type Raffle = {
  id: string;
  tradeshow_id: string;
  token: string;
  title: string;
  headline: string | null;
  description: string | null;
  terms: string | null;
  status: RaffleStatus;
  closes_at: string | null;
  ask_phone: boolean;
  require_phone: boolean;
  ask_company: boolean;
  /** Optional cap on entries; null = unlimited (20261111090000). */
  max_entries: number | null;
  created_by: string | null;
  created_at: string;
};

export type RafflePrize = {
  id: string;
  raffle_id: string;
  position: number;
  name: string;
  description: string | null;
  value: number | null;
  quantity: number;
};

export type RaffleEntry = {
  id: string;
  raffle_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  /** From the form's Industry dropdown (20261111140000); null on older entries. */
  industry: string | null;
  consent_marketing: boolean;
  disqualified_at: string | null;
  disqualified_reason: string | null;
  created_at: string;
};

export type RaffleWinner = {
  id: string;
  raffle_id: string;
  prize_id: string;
  entry_id: string;
  pool_size: number;
  drawn_at: string;
  drawn_by: string | null;
  status: WinnerStatus;
  notified_at: string | null;
  claimed_at: string | null;
  forfeited_at: string | null;
  forfeit_reason: string | null;
};

export type RaffleSummary = Raffle & {
  show_name: string;
  entries: number;
  prizes: number;
  winners: number;
};

export type RaffleDetail = {
  raffle: Raffle;
  show: { id: string; name: string; city: string | null; state: string | null };
  prizes: RafflePrize[];
  entries: RaffleEntry[];
  winners: RaffleWinner[];
};

/* ---- public form shapes (shared with raffle-public.functions.ts) ---- */

export type PublicRaffle =
  | { ok: false; reason: "not_found" | "error" }
  | {
      ok: true;
      open: boolean;
      /** The entry cap is reached (open is then false too). */
      full?: boolean;
      title: string;
      headline: string | null;
      description: string | null;
      terms: string | null;
      closes_at: string | null;
      ask_phone: boolean;
      require_phone: boolean;
      ask_company: boolean;
      show_name: string;
      show_city: string | null;
      show_state: string | null;
      show_starts_on: string | null;
      show_ends_on: string | null;
      prizes: {
        name: string;
        description: string | null;
        value: number | null;
        quantity: number;
      }[];
    };

export type RaffleEntryInput = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  company: string;
  job_title: string;
  industry: string;
  consent_terms: boolean;
  consent_marketing: boolean;
};

export type RaffleEntryResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "closed" | "full" | "invalid" | "duplicate" | "error" };

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

export const DEFAULT_RAFFLE_TERMS = [
  "1. Eligibility. Open to attendees of the trade show who are 18 or older. Employees of Gold Star Restoration and their immediate families are not eligible.",
  "2. How to enter. Complete the entry form during the show. One entry per person; duplicate entries are not counted. No purchase is necessary.",
  "3. Drawing. Winners are drawn at random from all eligible entries after entries close. Odds depend on the number of entries received.",
  "4. Notification. Winners are contacted by phone or email. A prize not claimed within 14 days may be forfeited and drawn again.",
  "5. Prizes. Prizes are as described, cannot be exchanged for cash and are not transferable. Winners are responsible for any taxes.",
  "6. General. Gold Star Restoration may disqualify incomplete or fraudulent entries and may change or cancel the giveaway if circumstances require.",
].join("\n\n");

/**
 * Shown under every raffle's own rules, whatever they say (11 Nov: "include
 * we have the right to send you marketing materials"). Agreeing to the terms
 * is what records marketing consent on the entry.
 */
export const RAFFLE_MARKETING_TERMS =
  "Marketing communications. By entering, you agree that Gold Star Restoration may contact you by email, phone or text with news, offers and marketing materials about our services. You can unsubscribe at any time using the link in any email or by asking us. We never sell your details.";

/** The Industry dropdown on the entry form. */
export const RAFFLE_INDUSTRIES = [
  "Property Management",
  "Real Estate Development / Investment",
  "Real Estate Brokerage",
  "Construction / General Contractor",
  "Construction Subcontractor / Trades",
  "Building Materials / Construction Supplier",
  "Insurance Agent / Broker",
  "Public Adjuster / Insurance Claims",
  "Restoration / Mitigation",
  "Facilities / Building Maintenance",
  "Healthcare / Senior Living",
  "Hospitality / Hotels",
  "Retail / Wholesale / Distribution",
  "Manufacturing / Industrial",
  "Transportation / Logistics",
  "Financial / Professional Services",
  "Technology / Software",
  "Marketing / Advertising",
  "Business Services / Vendors",
  "Other",
] as const;

/** One "Full Name" box: first word, then the rest ("Pat van der Berg" → Pat / van der Berg). */
export function splitFullName(full: string): { first_name: string; last_name: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" ") };
}

export function raffleEntryUrl(token: string, origin?: string): string {
  return `${origin ?? browserAppOrigin()}/raffle/${token}`;
}

/** Open means a visitor can enter right now: status and the closing time both agree. */
export function isRaffleOpen(r: Pick<Raffle, "status" | "closes_at">, now = Date.now()): boolean {
  return r.status === "open" && (!r.closes_at || new Date(r.closes_at).getTime() > now);
}

export type RafflePhase = "draft" | "open" | "closed" | "drawn";

/** What a person reading the list needs to know, in one word. */
export function rafflePhase(
  r: Pick<Raffle, "status" | "closes_at">,
  winners: number,
  now = Date.now(),
): RafflePhase {
  if (winners > 0) return "drawn";
  if (r.status === "draft") return "draft";
  return isRaffleOpen(r, now) ? "open" : "closed";
}

export const RAFFLE_PHASE: Record<RafflePhase, { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "neutral" },
  open: { label: "Taking entries", tone: "success" },
  closed: { label: "Entries closed", tone: "warning" },
  drawn: { label: "Winners drawn", tone: "brand" },
};

export const WINNER_STATUS: Record<WinnerStatus, { label: string; tone: Tone }> = {
  drawn: { label: "To contact", tone: "warning" },
  notified: { label: "Contacted", tone: "info" },
  claimed: { label: "Claimed", tone: "success" },
  forfeited: { label: "Forfeited", tone: "danger" },
};

export function fullName(e: Pick<RaffleEntry, "first_name" | "last_name">): string {
  return `${e.first_name} ${e.last_name}`.trim();
}

/** Winners still holding a prize slot (a forfeit frees the slot). */
export function activeWinners(winners: RaffleWinner[], prizeId: string): RaffleWinner[] {
  return winners.filter((w) => w.prize_id === prizeId && w.status !== "forfeited");
}

/** Who is still in the hat: not disqualified and never drawn for anything. */
export function eligibleEntries(entries: RaffleEntry[], winners: RaffleWinner[]): RaffleEntry[] {
  const drawn = new Set(winners.map((w) => w.entry_id));
  return entries.filter((e) => !e.disqualified_at && !drawn.has(e.id));
}

export function totalPrizeValue(prizes: RafflePrize[]): number {
  return prizes.reduce((s, p) => s + (p.value ?? 0) * p.quantity, 0);
}

export function prizeMoney(v: number | null | undefined): string {
  if (v == null) return "";
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: v % 1 === 0 ? 0 : 2,
  });
}

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas a visitor could type into a field.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Every contact, with how their entry ended, ready for a spreadsheet or a CRM import. */
export function rafflesCsv(detail: RaffleDetail): string {
  const prizeName = new Map(detail.prizes.map((p) => [p.id, p.name]));
  const winBy = new Map(detail.winners.map((w) => [w.entry_id, w]));
  const head = [
    "First name",
    "Last name",
    "Email",
    "Phone",
    "Company",
    "Job title",
    "Industry",
    "Marketing opt-in",
    "Entered at",
    "Status",
    "Prize",
    "Prize status",
  ];
  const rows = detail.entries.map((e) => {
    const w = winBy.get(e.id);
    return [
      e.first_name,
      e.last_name,
      e.email,
      e.phone,
      e.company,
      e.job_title,
      e.industry,
      e.consent_marketing ? "Yes" : "No",
      new Date(e.created_at).toISOString(),
      e.disqualified_at ? "Disqualified" : w ? "Winner" : "Entered",
      w ? (prizeName.get(w.prize_id) ?? "") : "",
      w ? WINNER_STATUS[w.status].label : "",
    ];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const RAFFLE_COLS =
  "id, tradeshow_id, token, title, headline, description, terms, status, closes_at, ask_phone, require_phone, ask_company, max_entries, created_by, created_at";

/** Raffles, newest first — for one show, or all of them. `available` is false before the migration. */
export async function listRaffles(
  tradeshowId?: string,
): Promise<{ raffles: RaffleSummary[]; available: boolean }> {
  let q = supabase
    .from("tradeshow_raffles")
    .select(`${RAFFLE_COLS}, tradeshows(name)`)
    .order("created_at", { ascending: false })
    .limit(200);
  if (tradeshowId) q = q.eq("tradeshow_id", tradeshowId);
  const { data, error } = await q;
  if (error) {
    if (isMissingSchema(error)) return { raffles: [], available: false };
    throw error;
  }
  const rows = (data ?? []) as unknown as (Raffle & { tradeshows: { name: string } | null })[];
  if (rows.length === 0) return { raffles: [], available: true };
  const ids = rows.map((r) => r.id);
  const [entries, prizes, winners] = await Promise.all([
    supabase.from("tradeshow_raffle_entries").select("raffle_id").in("raffle_id", ids),
    supabase.from("tradeshow_raffle_prizes").select("raffle_id, quantity").in("raffle_id", ids),
    supabase
      .from("tradeshow_raffle_winners")
      .select("raffle_id, status")
      .in("raffle_id", ids)
      .neq("status", "forfeited"),
  ]);
  const count = (list: { raffle_id: string; quantity?: number }[] | null, by = false) => {
    const m = new Map<string, number>();
    for (const r of list ?? [])
      m.set(r.raffle_id, (m.get(r.raffle_id) ?? 0) + (by ? (r.quantity ?? 1) : 1));
    return m;
  };
  const e = count(entries.data);
  const p = count(prizes.data, true);
  const w = count(winners.data);
  return {
    available: true,
    raffles: rows.map(({ tradeshows, ...r }) => ({
      ...r,
      show_name: tradeshows?.name ?? "Trade show",
      entries: e.get(r.id) ?? 0,
      prizes: p.get(r.id) ?? 0,
      winners: w.get(r.id) ?? 0,
    })),
  };
}

export async function fetchRaffleDetail(id: string): Promise<RaffleDetail | null> {
  const { data: raffle, error } = await supabase
    .from("tradeshow_raffles")
    .select(`${RAFFLE_COLS}, tradeshows(id, name, city, state)`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!raffle) return null;
  const [prizes, entries, winners] = await Promise.all([
    supabase
      .from("tradeshow_raffle_prizes")
      .select("id, raffle_id, position, name, description, value, quantity")
      .eq("raffle_id", id)
      .order("position")
      .order("created_at"),
    supabase
      .from("tradeshow_raffle_entries")
      .select(
        "id, raffle_id, first_name, last_name, email, phone, company, job_title, industry, consent_marketing, disqualified_at, disqualified_reason, created_at",
      )
      .eq("raffle_id", id)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase
      .from("tradeshow_raffle_winners")
      .select(
        "id, raffle_id, prize_id, entry_id, pool_size, drawn_at, drawn_by, status, notified_at, claimed_at, forfeited_at, forfeit_reason",
      )
      .eq("raffle_id", id)
      .order("drawn_at"),
  ]);
  for (const r of [prizes, entries, winners]) if (r.error) throw r.error;
  const { tradeshows, ...rest } = raffle as unknown as Raffle & {
    tradeshows: RaffleDetail["show"] | null;
  };
  return {
    raffle: rest,
    show: tradeshows ?? { id: rest.tradeshow_id, name: "Trade show", city: null, state: null },
    prizes: ((prizes.data ?? []) as RafflePrize[]).map((p) => ({
      ...p,
      value: p.value == null ? null : Number(p.value),
    })),
    entries: (entries.data ?? []) as RaffleEntry[],
    winners: (winners.data ?? []) as RaffleWinner[],
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

export type RaffleDraft = {
  title: string;
  headline: string;
  description: string;
  terms: string;
  closes_at: string | null;
  ask_phone: boolean;
  require_phone: boolean;
  ask_company: boolean;
  /** Optional entry cap as typed; empty = no limit. */
  max_entries: string;
  prizes: { id?: string; name: string; description: string; value: string; quantity: string }[];
};

const nn = (s: string) => (s.trim() ? s.trim() : null);
const cap = (s: string) => (s.trim() === "" ? null : Math.round(Number(s)));

function prizeRows(draft: RaffleDraft, raffleId: string) {
  return draft.prizes
    .filter((p) => p.name.trim())
    .map((p, i) => ({
      ...(p.id ? { id: p.id } : {}),
      raffle_id: raffleId,
      position: i + 1,
      name: p.name.trim(),
      description: nn(p.description),
      value: p.value.trim() === "" ? null : Math.max(0, Number(p.value) || 0),
      quantity: Math.min(100, Math.max(1, Math.round(Number(p.quantity) || 1))),
    }));
}

export function raffleDraftProblem(d: RaffleDraft): string | null {
  if (!d.title.trim()) return "Give the raffle a title.";
  if (!d.prizes.some((p) => p.name.trim())) return "Add at least one prize.";
  if (d.closes_at && Number.isNaN(new Date(d.closes_at).getTime()))
    return "The closing time is not a date.";
  const m = cap(d.max_entries);
  if (m != null && (!Number.isFinite(m) || m < 1 || m > 100000))
    return "Max entries must be a number from 1 to 100,000, or empty for no limit.";
  return null;
}

export async function createRaffle(input: {
  tradeshowId: string;
  draft: RaffleDraft;
  userId: string | null;
}): Promise<Raffle> {
  const d = input.draft;
  const { data, error } = await supabase
    .from("tradeshow_raffles")
    .insert({
      tradeshow_id: input.tradeshowId,
      title: d.title.trim(),
      headline: nn(d.headline),
      description: nn(d.description),
      terms: nn(d.terms),
      closes_at: d.closes_at,
      ask_phone: d.ask_phone,
      require_phone: d.ask_phone && d.require_phone,
      ask_company: d.ask_company,
      max_entries: cap(d.max_entries),
      status: "open",
      created_by: input.userId,
    })
    .select(RAFFLE_COLS)
    .single();
  if (error) throw error;
  const raffle = data as Raffle;
  const rows = prizeRows(d, raffle.id);
  if (rows.length) {
    const { error: pe } = await supabase.from("tradeshow_raffle_prizes").insert(rows);
    if (pe) throw pe;
  }
  return raffle;
}

export async function updateRaffle(id: string, draft: RaffleDraft, existing: RafflePrize[]) {
  const { error } = await supabase
    .from("tradeshow_raffles")
    .update({
      title: draft.title.trim(),
      headline: nn(draft.headline),
      description: nn(draft.description),
      terms: nn(draft.terms),
      closes_at: draft.closes_at,
      ask_phone: draft.ask_phone,
      require_phone: draft.ask_phone && draft.require_phone,
      ask_company: draft.ask_company,
      max_entries: cap(draft.max_entries),
    })
    .eq("id", id);
  if (error) throw error;

  const rows = prizeRows(draft, id);
  const keep = new Set(rows.map((r) => r.id).filter(Boolean));
  const removed = existing.filter((p) => !keep.has(p.id));
  for (const p of removed) {
    const { error: de } = await supabase.from("tradeshow_raffle_prizes").delete().eq("id", p.id);
    if (de) throw de;
  }
  for (const r of rows) {
    const { error: we } = r.id
      ? await supabase.from("tradeshow_raffle_prizes").update(r).eq("id", r.id)
      : await supabase.from("tradeshow_raffle_prizes").insert(r);
    if (we) throw we;
  }
}

export async function setRaffleStatus(id: string, status: RaffleStatus, reopen = false) {
  const patch: Record<string, unknown> = { status };
  // Reopening a raffle whose closing time has passed would still be closed.
  if (reopen) patch.closes_at = null;
  const { error } = await supabase.from("tradeshow_raffles").update(patch).eq("id", id);
  if (error) throw error;
}

export async function deleteRaffle(id: string) {
  const { error, count } = await supabase
    .from("tradeshow_raffles")
    .delete({ count: "exact" })
    .eq("id", id);
  if (error) throw error;
  if (!count) throw new Error("A raffle with entries cannot be deleted. Close it instead.");
}

/** Draw the prize's open slots (or `count` of them) in the database. */
export async function drawWinners(prizeId: string, count?: number): Promise<RaffleWinner[]> {
  const { data, error } = await supabase.rpc("draw_raffle_winners", {
    _prize_id: prizeId,
    _count: count ?? null,
  });
  if (error) throw error;
  return (data ?? []) as RaffleWinner[];
}

export async function setWinnerStatus(id: string, status: WinnerStatus, reason?: string | null) {
  const { error } = await supabase
    .from("tradeshow_raffle_winners")
    .update({ status, ...(status === "forfeited" ? { forfeit_reason: reason ?? null } : {}) })
    .eq("id", id);
  if (error) throw error;
}

export async function setEntryDisqualified(
  id: string,
  disqualified: boolean,
  reason: string | null,
  userId: string | null,
) {
  const { error } = await supabase
    .from("tradeshow_raffle_entries")
    .update(
      disqualified
        ? {
            disqualified_at: new Date().toISOString(),
            disqualified_reason: reason,
            disqualified_by: userId,
          }
        : { disqualified_at: null, disqualified_reason: null, disqualified_by: null },
    )
    .eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Across raffles: every prize and every winner, for the boards        */
/* ------------------------------------------------------------------ */

export type PrizeRow = RafflePrize & {
  raffle_title: string;
  tradeshow_id: string;
  show_name: string;
  /** Winners still holding this prize (forfeits excluded). */
  awarded: number;
};

export type WinnerRow = RaffleWinner & {
  raffle_title: string;
  tradeshow_id: string;
  show_name: string;
  prize_name: string;
  prize_value: number | null;
  name: string;
  email: string;
  phone: string | null;
  company: string | null;
  industry: string | null;
};

type RaffleRef = {
  title: string;
  tradeshow_id: string;
  tradeshows: { name: string } | null;
} | null;

/** Prizes and winners for the given raffles (one show's, or all of them). */
export async function listPrizesAndWinners(
  raffleIds: string[],
): Promise<{ prizes: PrizeRow[]; winners: WinnerRow[] }> {
  if (raffleIds.length === 0) return { prizes: [], winners: [] };
  const raffleRef = "tradeshow_raffles(title, tradeshow_id, tradeshows(name))";
  const [prizes, winners] = await Promise.all([
    supabase
      .from("tradeshow_raffle_prizes")
      .select(`id, raffle_id, position, name, description, value, quantity, ${raffleRef}`)
      .in("raffle_id", raffleIds)
      .order("position")
      .limit(2000),
    supabase
      .from("tradeshow_raffle_winners")
      .select(
        `id, raffle_id, prize_id, entry_id, pool_size, drawn_at, drawn_by, status, notified_at, claimed_at, forfeited_at, forfeit_reason, ${raffleRef}, tradeshow_raffle_prizes(name, value), tradeshow_raffle_entries(first_name, last_name, email, phone, company, industry)`,
      )
      .in("raffle_id", raffleIds)
      .order("drawn_at", { ascending: false })
      .limit(2000),
  ]);
  if (prizes.error) throw prizes.error;
  if (winners.error) throw winners.error;

  const winnerRows = (
    (winners.data ?? []) as unknown as (RaffleWinner & {
      tradeshow_raffles: RaffleRef;
      tradeshow_raffle_prizes: { name: string; value: number | null } | null;
      tradeshow_raffle_entries: Pick<
        RaffleEntry,
        "first_name" | "last_name" | "email" | "phone" | "company" | "industry"
      > | null;
    })[]
  ).map(
    ({ tradeshow_raffles: r, tradeshow_raffle_prizes: p, tradeshow_raffle_entries: e, ...w }) => ({
      ...w,
      raffle_title: r?.title ?? "Raffle",
      tradeshow_id: r?.tradeshow_id ?? "",
      show_name: r?.tradeshows?.name ?? "Trade show",
      prize_name: p?.name ?? "Prize",
      prize_value: p?.value == null ? null : Number(p.value),
      name: e ? fullName(e) : "Unknown entrant",
      email: e?.email ?? "",
      phone: e?.phone ?? null,
      company: e?.company ?? null,
      industry: e?.industry ?? null,
    }),
  );

  const awarded = new Map<string, number>();
  for (const w of winnerRows)
    if (w.status !== "forfeited") awarded.set(w.prize_id, (awarded.get(w.prize_id) ?? 0) + 1);

  const prizeRows = (
    (prizes.data ?? []) as unknown as (RafflePrize & { tradeshow_raffles: RaffleRef })[]
  ).map(({ tradeshow_raffles: r, ...p }) => ({
    ...p,
    value: p.value == null ? null : Number(p.value),
    raffle_title: r?.title ?? "Raffle",
    tradeshow_id: r?.tradeshow_id ?? "",
    show_name: r?.tradeshows?.name ?? "Trade show",
    awarded: awarded.get(p.id) ?? 0,
  }));

  return { prizes: prizeRows, winners: winnerRows };
}
