import { supabase } from "@/integrations/supabase/client";

/**
 * "My Goals" — the rep-facing view of their own targets.
 *
 * Attainment itself comes from `useGoalProgress` so this page and the
 * dashboard goal card can never disagree. What lives here is the surrounding
 * context a rep actually acts on: the highest-leverage next steps pulled from
 * real records, and the wins already banked in the period.
 *
 * Money never leaks: every dollar figure returned is optional and the caller
 * decides whether the viewer may see it (`canSeeMoney`).
 */

export type NextStep = {
  id: string;
  kind: "estimate" | "inspection" | "aging_lead";
  title: string;
  detail: string;
  /** Dollar weight, when there is one. Callers gate display on role. */
  value: number | null;
  /** Sort weight — bigger is more urgent/valuable. */
  weight: number;
  href: string;
};

export type Win = {
  id: string;
  jobNumber: string | null;
  name: string;
  closedOn: string;
  value: number | null;
  href: string;
};

export type RepSnapshot = {
  nextSteps: NextStep[];
  wins: Win[];
  /** Meetings held ÷ accounts advanced in the window — the conversion metric. */
  conversion: number | null;
};

const iso = (d: Date) => d.toISOString();
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

/** The largest estimate this rep has out that nobody has decided on yet. */
async function openEstimates(userId: string): Promise<NextStep[]> {
  const { data, error } = await supabase
    .from("estimates")
    .select("id,seq,total,status,customer_name,job_number,created_at,created_by")
    .eq("created_by", userId)
    .in("status", ["draft", "sent"])
    .is("decided_at", null)
    .order("total", { ascending: false, nullsFirst: false })
    .limit(3);
  if (error) throw error;
  return (data ?? []).map((e) => ({
    id: `est-${e.id}`,
    kind: "estimate" as const,
    title: `Close the ${e.status === "sent" ? "sent" : "draft"} estimate for ${
      e.customer_name || e.job_number || "this job"
    }`,
    detail:
      e.status === "sent"
        ? `Sent, still undecided — chase the decision.`
        : `Still a draft — get it in front of them.`,
    value: e.total == null ? null : Number(e.total),
    weight: 1_000_000 + Number(e.total ?? 0),
    href: `/estimates/${e.id}`,
  }));
}

/** In-person meetings logged with no reply since — waiting on the customer. */
async function silentInspections(userId: string): Promise<NextStep[]> {
  const { data, error } = await supabase
    .from("touchpoints")
    .select("id,account_id,occurred_at,type,replied_at,notes")
    .eq("created_by", userId)
    .in("type", ["meeting_in_person", "meeting_virtual"])
    .is("replied_at", null)
    .lte("occurred_at", iso(daysAgo(3)))
    .order("occurred_at", { ascending: true })
    .limit(20);
  if (error) throw error;
  const rows = (data ?? []).filter((t) => t.account_id);
  if (rows.length === 0) return [];

  const ids = [...new Set(rows.map((t) => t.account_id as string))];
  const { data: accts } = await supabase.from("accounts").select("id,name").in("id", ids);
  const names = new Map((accts ?? []).map((a) => [a.id, a.name as string]));

  const seen = new Set<string>();
  const out: NextStep[] = [];
  for (const t of rows) {
    const accountId = t.account_id as string;
    if (seen.has(accountId)) continue;
    seen.add(accountId);
    const days = Math.round((Date.now() - new Date(t.occurred_at).getTime()) / 86_400_000);
    out.push({
      id: `insp-${t.id}`,
      kind: "inspection",
      title: `Follow up with ${names.get(accountId) ?? "this account"}`,
      detail: `Inspection ${days} day${days === 1 ? "" : "s"} ago, no response yet.`,
      value: null,
      weight: 500_000 + days,
      href: `/accounts/${accountId}`,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/** Prospects this rep owns that nobody has touched in a fortnight. */
async function agingLeads(userId: string): Promise<NextStep[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id,name,created_at,status")
    .eq("assigned_rep", userId)
    .eq("status", "prospect")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const { data: touches } = await supabase
    .from("touchpoints")
    .select("account_id,occurred_at")
    .in(
      "account_id",
      rows.map((a) => a.id),
    )
    .gte("occurred_at", iso(daysAgo(14)))
    .limit(2000);
  const touched = new Set((touches ?? []).map((t) => t.account_id));

  return rows
    .filter((a) => !touched.has(a.id))
    .slice(0, 3)
    .map((a) => {
      const days = Math.round((Date.now() - new Date(a.created_at).getTime()) / 86_400_000);
      return {
        id: `lead-${a.id}`,
        kind: "aging_lead" as const,
        title: `Contact ${a.name}`,
        detail: `Open lead, no touch in the last 14 days${days > 14 ? ` · ${days} days old` : ""}.`,
        value: null,
        weight: 100_000 + days,
        href: `/accounts/${a.id}`,
      };
    });
}

/** Jobs on this rep's accounts that closed inside the window. */
async function recentWins(userId: string, from: Date, to: Date): Promise<Win[]> {
  const { data: accts, error: aErr } = await supabase
    .from("accounts")
    .select("id")
    .eq("assigned_rep", userId)
    .limit(2000);
  if (aErr) throw aErr;
  const ids = (accts ?? []).map((a) => a.id);
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("jobs")
    .select(
      "id,job_number,job_name,customer_name,status,billed_amount,agreed_price,created_at,completion_date,updated_at",
    )
    .in("account_id", ids)
    .in("status", ["complete", "invoiced", "paid"])
    .gte("created_at", iso(from))
    .lte("created_at", iso(to))
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;

  return (data ?? []).map((j) => ({
    id: j.id,
    jobNumber: j.job_number,
    name: j.job_name || j.customer_name || j.job_number || "Job",
    closedOn: j.completion_date ?? j.updated_at ?? j.created_at,
    value:
      j.billed_amount != null
        ? Number(j.billed_amount)
        : j.agreed_price != null
          ? Number(j.agreed_price)
          : null,
    href: `/jobs/${j.id}`,
  }));
}

export async function fetchRepSnapshot(userId: string, from: Date, to: Date): Promise<RepSnapshot> {
  const [est, insp, leads, wins] = await Promise.all([
    openEstimates(userId).catch(() => [] as NextStep[]),
    silentInspections(userId).catch(() => [] as NextStep[]),
    agingLeads(userId).catch(() => [] as NextStep[]),
    recentWins(userId, from, to).catch(() => [] as Win[]),
  ]);
  const nextSteps = [...est, ...insp, ...leads].sort((a, b) => b.weight - a.weight).slice(0, 5);
  return { nextSteps, wins, conversion: null };
}

/* ------------------------------------------------------------------ */
/* Who can this person open?                                           */
/* ------------------------------------------------------------------ */

export type RepOption = { userId: string; name: string };

/** People whose goals the viewer may open. RLS decides what comes back. */
export async function fetchViewableReps(): Promise<RepOption[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id,full_name,is_active")
    .order("full_name");
  if (error) throw error;
  return (data ?? [])
    .filter((p) => p.is_active !== false)
    .map((p) => ({ userId: p.user_id, name: p.full_name?.trim() || "Unnamed" }));
}

/** The sales leadership this rep reports into, for review requests. */
export async function fetchMyLeadership(): Promise<RepOption[]> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("user_id,role")
    .in("role", ["sales_head", "sales_manager", "location_manager"]);
  if (error) return [];
  const ids = [...new Set((data ?? []).map((r) => r.user_id))];
  if (ids.length === 0) return [];
  const { data: profs } = await supabase
    .from("profiles")
    .select("user_id,full_name")
    .in("user_id", ids);
  return (profs ?? []).map((p) => ({
    userId: p.user_id,
    name: p.full_name?.trim() || "Unnamed",
  }));
}

/** Find or create the direct conversation between two people. */
export async function openDirectConversation(me: string, them: string): Promise<string> {
  const [{ data: mine }, { data: theirs }] = await Promise.all([
    supabase.from("conversation_members").select("conversation_id").eq("user_id", me),
    supabase.from("conversation_members").select("conversation_id").eq("user_id", them),
  ]);
  const mineSet = new Set((mine ?? []).map((r) => r.conversation_id));
  const shared = (theirs ?? []).map((r) => r.conversation_id).filter((id) => mineSet.has(id));
  if (shared.length > 0) {
    const { data: convs } = await supabase
      .from("conversations")
      .select("id,kind")
      .in("id", shared)
      .eq("kind", "direct")
      .limit(1);
    if (convs?.[0]?.id) return convs[0].id as string;
  }
  const { data: conv, error } = await supabase
    .from("conversations")
    .insert({ kind: "direct", created_by: me })
    .select("id")
    .single();
  if (error) throw error;
  const { error: mErr } = await supabase.from("conversation_members").insert([
    { conversation_id: conv.id, user_id: me, is_admin: true },
    { conversation_id: conv.id, user_id: them, is_admin: false },
  ]);
  if (mErr) throw mErr;
  return conv.id as string;
}

/** Post a goal-review request into the manager's direct chat. */
export async function requestGoalReview(opts: {
  me: string;
  managerId: string;
  periodLabel: string;
  attainment: number | null;
  daysLeft: number;
}): Promise<string> {
  const conversationId = await openDirectConversation(opts.me, opts.managerId);
  const pct =
    opts.attainment == null ? "no target set" : `${Math.round(opts.attainment * 100)}% of target`;
  const body = `Requesting a goal review for ${opts.periodLabel} — currently ${pct} with ${opts.daysLeft} day${
    opts.daysLeft === 1 ? "" : "s"
  } left in the period.`;
  const { error } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: opts.me, body });
  if (error) throw error;
  return conversationId;
}
