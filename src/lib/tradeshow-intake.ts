/**
 * Intake links that belong to a trade show.
 *
 * The standalone intake link (intake-inbox.ts) is minted for one person and
 * closes after one submission. A show link is the same row with two
 * differences: it carries `tradeshow_id`, and it is `multi_use` — a QR code on
 * a booth is scanned by everyone who stops, so it stays open until it expires
 * or is revoked. Every submission through it is attributed to the show on the
 * way in (see tradeshow-intake.server.ts), so it lands beside the leads
 * captured on the tablet.
 */
import { browserAppOrigin } from "@/lib/app-origin";
import { supabase } from "@/integrations/supabase/client";
import { formLinkDefaults } from "@/lib/form-links";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { Tradeshow } from "@/lib/tradeshows";

export type TradeshowIntakeLink = {
  id: string;
  token: string;
  label: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  created_by: string | null;
  /** Submissions through this link so far. */
  submissions: number;
};

export type TradeshowFormSubmission = {
  id: string;
  request_id: string;
  created_at: string;
  status: string;
  account_id: string | null;
  submitted_by_name: string | null;
  fields: Record<string, string | null>;
};

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;

/** What the link is called unless someone renames it: the show. */
export function defaultShowLinkLabel(show: Pick<Tradeshow, "name">): string {
  return show.name.trim() || "Trade show form";
}

/**
 * A show link must outlive the show. The office default (30 days unless an
 * admin changed it) applies, but never expires before two weeks after the
 * show's last day — the QR is still on a banner in someone's boot by then.
 */
export function showLinkExpiry(
  show: Pick<Tradeshow, "ends_on" | "starts_on">,
  defaultDays: number,
  now: Date = new Date(),
): string {
  const byDefault = now.getTime() + Math.max(1, defaultDays) * DAY;
  const lastDay = show.ends_on ?? show.starts_on;
  const afterShow = lastDay
    ? new Date(`${lastDay.slice(0, 10)}T23:59:59Z`).getTime() + 14 * DAY
    : 0;
  return new Date(Math.max(byDefault, afterShow)).toISOString();
}

/** The public URL a token resolves to. `origin` is passed in so this is testable. */
export function tradeshowIntakeUrl(token: string, origin?: string): string {
  const base = origin ?? browserAppOrigin();
  return `${base}/intake/${token}`;
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export async function createTradeshowIntakeLink(input: {
  show: Tradeshow;
  locationId: string;
  label: string | null;
  userId: string | null;
}): Promise<TradeshowIntakeLink> {
  const defaults = await formLinkDefaults();
  const { data, error } = await supabase
    .from("intake_requests")
    .insert({
      job_id: null,
      tradeshow_id: input.show.id,
      location_id: input.locationId,
      multi_use: true,
      label: input.label?.trim() || defaultShowLinkLabel(input.show),
      expires_at: showLinkExpiry(input.show, defaults.expires_in_days),
      created_by: input.userId,
    })
    .select("id, token, label, created_at, expires_at, revoked_at, created_by")
    .single();
  if (error) throw error;
  return { ...(data as Omit<TradeshowIntakeLink, "submissions">), submissions: 0 };
}

/**
 * Links minted for this show, newest first. `available` is false when the
 * database has not taken the show-link migration yet — the panel must say so
 * rather than offer a button that will fail.
 */
export async function listTradeshowIntakeLinks(
  tradeshowId: string,
): Promise<{ links: TradeshowIntakeLink[]; available: boolean }> {
  const { data, error } = await supabase
    .from("intake_requests")
    .select("id, token, label, created_at, expires_at, revoked_at, created_by")
    .eq("tradeshow_id", tradeshowId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isMissingSchema(error)) return { links: [], available: false };
    throw error;
  }
  const links = (data ?? []) as Omit<TradeshowIntakeLink, "submissions">[];
  if (links.length === 0) return { links: [], available: true };

  const counts = new Map<string, number>();
  const { data: subs } = await supabase
    .from("intake_submissions")
    .select("request_id")
    .in(
      "request_id",
      links.map((l) => l.id),
    );
  for (const s of subs ?? []) {
    counts.set(s.request_id, (counts.get(s.request_id) ?? 0) + 1);
  }
  return {
    links: links.map((l) => ({ ...l, submissions: counts.get(l.id) ?? 0 })),
    available: true,
  };
}

export async function revokeIntakeLink(id: string): Promise<void> {
  const { error } = await supabase
    .from("intake_requests")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Everything submitted through this show's links, newest first. */
export async function listTradeshowFormSubmissions(
  tradeshowId: string,
): Promise<TradeshowFormSubmission[]> {
  const { data, error } = await supabase
    .from("intake_submissions")
    .select(
      "id, request_id, created_at, status, account_id, submitted_by_name, fields, intake_requests!inner(tradeshow_id)",
    )
    .eq("intake_requests.tradeshow_id", tradeshowId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []).map((r) => ({
    id: r.id,
    request_id: r.request_id,
    created_at: r.created_at,
    status: r.status,
    account_id: (r as { account_id?: string | null }).account_id ?? null,
    submitted_by_name: r.submitted_by_name,
    fields: (r.fields ?? {}) as Record<string, string | null>,
  }));
}

export function isLinkLive(
  link: Pick<TradeshowIntakeLink, "revoked_at" | "expires_at">,
  now = Date.now(),
): boolean {
  return !link.revoked_at && new Date(link.expires_at).getTime() > now;
}
