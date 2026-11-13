import { supabase } from "@/integrations/supabase/client";
import { fetchTradeshowLeadMedia, type LeadMedia } from "@/lib/tradeshow-capture";

/**
 * Tradeshows as a first-class source. The only question that matters is which
 * shows are worth attending, so a show is stored with its cost and every
 * account and job it produced is attributed back to it.
 */

export type Tradeshow = {
  id: string;
  location_id: string | null;
  name: string;
  city: string | null;
  state: string | null;
  starts_on: string | null;
  ends_on: string | null;
  cost: number;
  leads_captured: number;
  notes: string | null;
  archived_at: string | null;
};

export type TradeshowRoi = {
  tradeshow_id: string;
  name: string;
  starts_on: string | null;
  cost: number;
  leads_captured: number;
  accounts_created: number;
  jobs_won: number;
  billed_value: number;
};

export type TradeshowLeadCount = {
  count: number;
  /** `legacy` is an honest fallback while the ROI RPC is unavailable. */
  source: "attributed" | "legacy";
};

/**
 * Captured leads are the account records attributed to the show. The old
 * hand-entered total survives only as a fallback for a live database where
 * the ROI function cannot be read yet; callers can label that state rather
 * than presenting the estimate as a measured conversion.
 */
export function tradeshowLeadCount(
  show: Pick<Tradeshow, "leads_captured">,
  roi: Pick<TradeshowRoi, "accounts_created"> | null | undefined,
): TradeshowLeadCount {
  if (roi) return { count: Math.max(0, Number(roi.accounts_created) || 0), source: "attributed" };
  return { count: Math.max(0, Number(show.leads_captured) || 0), source: "legacy" };
}

export async function fetchTradeshows(): Promise<Tradeshow[]> {
  const { data, error } = await supabase
    .from("tradeshows")
    .select(
      "id,location_id,name,city,state,starts_on,ends_on,cost,leads_captured,notes,archived_at",
    )
    .is("archived_at", null)
    .order("starts_on", { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Tradeshow[];
}

export async function fetchTradeshowRoi(): Promise<TradeshowRoi[]> {
  const { data, error } = await supabase.rpc("tradeshow_roi");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    tradeshow_id: r.tradeshow_id as string,
    name: r.name as string,
    starts_on: r.starts_on as string | null,
    cost: Number(r.cost ?? 0),
    leads_captured: Number(r.leads_captured ?? 0),
    accounts_created: Number(r.accounts_created ?? 0),
    jobs_won: Number(r.jobs_won ?? 0),
    billed_value: Number(r.billed_value ?? 0),
  }));
}

export type SaveTradeshowInput = {
  id?: string;
  location_id: string | null;
  name: string;
  city: string | null;
  state: string | null;
  starts_on: string | null;
  ends_on: string | null;
  cost: number;
  leads_captured: number;
  notes: string | null;
};

export async function saveTradeshow(input: SaveTradeshowInput): Promise<void> {
  if (input.id) {
    const { id, ...rest } = input;
    const { error } = await supabase.from("tradeshows").update(rest).eq("id", id);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from("tradeshows").insert(input);
  if (error) throw error;
}

export async function archiveTradeshow(id: string): Promise<void> {
  const { error } = await supabase
    .from("tradeshows")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

/** Cost per account created — the number that decides next year's calendar. */
export function costPerAccount(r: TradeshowRoi): number | null {
  return r.accounts_created > 0 ? r.cost / r.accounts_created : null;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseDay(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "Oct 14–15, 2026", "Oct 30 – Nov 2, 2026", "Dec 30, 2026 – Jan 2, 2027".
 * One string, en dash, never split across lines by the caller.
 */
export function formatShowDates(startsOn: string | null, endsOn: string | null): string {
  const a = parseDay(startsOn);
  const b = parseDay(endsOn);
  if (!a && !b) return "—";
  if (!a) return formatShowDates(endsOn, null);
  const day = (d: Date) => d.getUTCDate();
  const mon = (d: Date) => MONTH[d.getUTCMonth()];
  const yr = (d: Date) => d.getUTCFullYear();
  if (!b || (yr(a) === yr(b) && a.getUTCMonth() === b.getUTCMonth() && day(a) === day(b))) {
    return `${mon(a)} ${day(a)}, ${yr(a)}`;
  }
  if (yr(a) !== yr(b)) return `${mon(a)} ${day(a)}, ${yr(a)} – ${mon(b)} ${day(b)}, ${yr(b)}`;
  if (a.getUTCMonth() !== b.getUTCMonth()) {
    return `${mon(a)} ${day(a)} – ${mon(b)} ${day(b)}, ${yr(a)}`;
  }
  return `${mon(a)} ${day(a)}\u2013${day(b)}, ${yr(a)}`;
}

/** $7,800 — whole dollars, grouped. */
export function showMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Math.round(Number(n)).toLocaleString("en-US")}`;
}

/* ------------------------------------------------------------------ */
/* Detail page                                                         */
/* ------------------------------------------------------------------ */

export type ShowAccount = {
  id: string;
  name: string;
  status: string | null;
  stage: string | null;
  estimated_annual_value: number | null;
  assigned_rep: string | null;
  created_at: string;
  contact_name: string | null;
  /** The primary contact's row id, so the review pass updates it rather than adding a second. */
  contact_id: string | null;
  phone: string | null;
  email: string | null;
};

export type ShowJob = {
  id: string;
  job_number: string | null;
  name: string;
  status: string | null;
  value: number | null;
  created_at: string;
  account_id: string | null;
};

export type ShowAttendee = {
  id: string;
  user_id: string;
  name: string;
  role_note: string | null;
};

export type ShowNote = {
  id: string;
  body: string;
  created_at: string;
  created_by: string | null;
  author: string | null;
};

export type TradeshowDetail = {
  show: Tradeshow;
  roi: TradeshowRoi | null;
  accounts: ShowAccount[];
  jobs: ShowJob[];
  attendees: ShowAttendee[];
  notes: ShowNote[];
  /** Photos and voice notes captured on the tablet, newest first. */
  media: LeadMedia[];
  repNames: Record<string, string>;
};

const WON_JOB_STATUSES = ["scheduled", "in_progress", "drying", "complete", "invoiced", "paid"];

export async function fetchTradeshowDetail(id: string): Promise<TradeshowDetail> {
  const { data: showRow, error: showErr } = await supabase
    .from("tradeshows")
    .select(
      "id,location_id,name,city,state,starts_on,ends_on,cost,leads_captured,notes,archived_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (showErr) throw showErr;
  if (!showRow) throw new Error("Show not found");
  const show = showRow as Tradeshow;

  const [accRes, jobRes, attRes, noteRes, roiRows, media] = await Promise.all([
    supabase
      .from("accounts")
      .select("id,name,status,stage,estimated_annual_value,assigned_rep,created_at,phone,email")
      .eq("tradeshow_id", id)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase
      .from("jobs")
      .select(
        "id,job_number,job_name,customer_name,status,billed_amount,agreed_price,created_at,account_id",
      )
      .eq("tradeshow_id", id)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("tradeshow_attendees").select("id,user_id,role_note").eq("tradeshow_id", id),
    supabase
      .from("tradeshow_notes")
      .select("id,body,created_at,created_by")
      .eq("tradeshow_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
    fetchTradeshowRoi().catch(() => [] as TradeshowRoi[]),
    // Captures are decoration on the list; a missing table (migration not yet
    // applied) must not take the whole show page down with it.
    fetchTradeshowLeadMedia(id).catch(() => [] as LeadMedia[]),
  ]);
  if (accRes.error) throw accRes.error;
  if (jobRes.error) throw jobRes.error;

  const accountRows = (accRes.data ?? []) as Record<string, unknown>[];
  const accountIds = accountRows.map((a) => a.id as string);

  const contactsByAccount = new Map<string, { id: string; name: string }>();
  if (accountIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id,account_id,full_name,is_primary,is_decision_maker")
      .in("account_id", accountIds)
      .is("archived_at", null)
      .limit(1000);
    for (const c of contacts ?? []) {
      const key = c.account_id as string | null;
      const full = (c.full_name ?? "").trim();
      if (!key || !full) continue;
      if (!contactsByAccount.has(key) || c.is_primary || c.is_decision_maker) {
        contactsByAccount.set(key, { id: c.id as string, name: full });
      }
    }
  }

  const userIds = [
    ...new Set(
      [
        ...accountRows.map((a) => a.assigned_rep as string | null),
        ...((attRes.data ?? []) as { user_id: string }[]).map((a) => a.user_id),
        ...((noteRes.data ?? []) as { created_by: string | null }[]).map((n) => n.created_by),
      ].filter(Boolean) as string[],
    ),
  ];
  const repNames: Record<string, string> = {};
  if (userIds.length > 0) {
    const { data: profs } = await supabase
      .from("profiles")
      .select("user_id,full_name")
      .in("user_id", userIds);
    for (const p of profs ?? []) {
      repNames[p.user_id] = p.full_name?.trim() || "Unnamed";
    }
  }

  const accounts: ShowAccount[] = accountRows.map((a) => ({
    id: a.id as string,
    name: a.name as string,
    status: (a.status as string | null) ?? null,
    stage: (a.stage as string | null) ?? null,
    estimated_annual_value:
      a.estimated_annual_value == null ? null : Number(a.estimated_annual_value),
    assigned_rep: (a.assigned_rep as string | null) ?? null,
    created_at: a.created_at as string,
    contact_name: contactsByAccount.get(a.id as string)?.name ?? null,
    contact_id: contactsByAccount.get(a.id as string)?.id ?? null,
    phone: (a.phone as string | null) ?? null,
    email: (a.email as string | null) ?? null,
  }));

  const jobs: ShowJob[] = ((jobRes.data ?? []) as Record<string, unknown>[]).map((j) => ({
    id: j.id as string,
    job_number: (j.job_number as string | null) ?? null,
    name:
      (j.job_name as string | null) ||
      (j.customer_name as string | null) ||
      (j.job_number as string | null) ||
      "Job",
    status: (j.status as string | null) ?? null,
    value:
      j.billed_amount != null
        ? Number(j.billed_amount)
        : j.agreed_price != null
          ? Number(j.agreed_price)
          : null,
    created_at: j.created_at as string,
    account_id: (j.account_id as string | null) ?? null,
  }));

  const attendees: ShowAttendee[] = ((attRes.data ?? []) as Record<string, unknown>[])
    .map((a) => ({
      id: a.id as string,
      user_id: a.user_id as string,
      name: repNames[a.user_id as string] ?? "Unnamed",
      role_note: (a.role_note as string | null) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const notes: ShowNote[] = ((noteRes.data ?? []) as Record<string, unknown>[]).map((n) => ({
    id: n.id as string,
    body: n.body as string,
    created_at: n.created_at as string,
    created_by: (n.created_by as string | null) ?? null,
    author: n.created_by ? (repNames[n.created_by as string] ?? null) : null,
  }));

  return {
    show,
    roi: roiRows.find((r) => r.tradeshow_id === id) ?? null,
    accounts,
    jobs,
    attendees,
    notes,
    media,
    repNames,
  };
}

export type ShowRoiNumbers = {
  cost: number;
  leads: number;
  accounts: number;
  jobsWon: number;
  revenue: number;
  costPerLead: number | null;
  costPerAccount: number | null;
  costPerJob: number | null;
  /** Revenue signed ÷ cost. Above 1 means the show paid for itself. */
  returnVsCost: number | null;
};

/** The ROI block, computed from attributed records rather than a hand-entered estimate. */
export function showRoiNumbers(d: TradeshowDetail): ShowRoiNumbers {
  const cost = Number(d.show.cost ?? 0);
  // The ROI function includes archived attributed accounts, preserving the
  // historical show conversion after an account leaves the active UI query.
  const accounts = d.roi ? Math.max(0, Number(d.roi.accounts_created) || 0) : d.accounts.length;
  const leads = accounts;
  const wonJobs = d.jobs.filter((j) => j.status && WON_JOB_STATUSES.includes(j.status));
  const revenue = wonJobs.reduce((sum, j) => sum + (j.value ?? 0), 0);
  const per = (n: number) => (n > 0 && cost > 0 ? cost / n : null);
  return {
    cost,
    leads,
    accounts,
    jobsWon: wonJobs.length,
    revenue,
    costPerLead: per(leads),
    costPerAccount: per(accounts),
    costPerJob: per(wonJobs.length),
    returnVsCost: cost > 0 ? revenue / cost : null,
  };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/** Fix attribution after the fact: point an existing account at this show. */
export async function linkAccountToShow(accountId: string, tradeshowId: string): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ tradeshow_id: tradeshowId })
    .eq("id", accountId);
  if (error) throw error;
}

export async function unlinkAccountFromShow(accountId: string): Promise<void> {
  const { error } = await supabase
    .from("accounts")
    .update({ tradeshow_id: null })
    .eq("id", accountId);
  if (error) throw error;
}

export async function searchAccountsForShow(term: string) {
  let sel = supabase
    .from("accounts")
    .select("id,name,city,state,tradeshow_id")
    .is("archived_at", null);
  if (term) sel = sel.ilike("name", `%${term}%`);
  const { data, error } = await sel.order("name").limit(20);
  if (error) throw error;
  return data ?? [];
}

export async function addShowAttendee(
  tradeshowId: string,
  userId: string,
  roleNote: string | null,
  createdBy: string | null,
): Promise<void> {
  const { error } = await supabase.from("tradeshow_attendees").insert({
    tradeshow_id: tradeshowId,
    user_id: userId,
    role_note: roleNote,
    created_by: createdBy,
  });
  if (error) throw error;
}

export async function removeShowAttendee(id: string): Promise<void> {
  const { error } = await supabase.from("tradeshow_attendees").delete().eq("id", id);
  if (error) throw error;
}

export async function addShowNote(
  tradeshowId: string,
  body: string,
  createdBy: string,
): Promise<void> {
  const { error } = await supabase
    .from("tradeshow_notes")
    .insert({ tradeshow_id: tradeshowId, body, created_by: createdBy });
  if (error) throw error;
}
