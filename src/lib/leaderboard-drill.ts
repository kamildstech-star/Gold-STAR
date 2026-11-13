import { supabase } from "@/integrations/supabase/client";
import { countsTowardRep } from "@/lib/account-ownership";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";

/**
 * Leaderboard drill-through.
 *
 * Every primary column on the board answers "which records made this number?".
 * Queries run through the caller's own client, so RLS decides what a viewer is
 * allowed to see — the board never widens visibility.
 */

export type DrillMetric =
  "jobs_insurance" | "jobs_cash" | "jobs_total" | "calls" | "advances" | "meetings";

export type DrillRow = {
  id: string;
  title: string;
  subtitle: string | null;
  at: string | null;
  href?: string;
};

export const DRILL_LABEL: Record<DrillMetric, string> = {
  jobs_insurance: "Jobs signed — insurance",
  jobs_cash: "Jobs signed — cash",
  jobs_total: "Jobs signed",
  calls: "Calls made",
  advances: "Stage advances",
  meetings: "Meetings held",
};

async function jobRows(
  userId: string,
  from: Date,
  to: Date,
  kind: "insurance" | "cash" | "all",
): Promise<DrillRow[]> {
  const { data: accounts, error: accErr } = await supabase
    .from("accounts")
    .select("id")
    .eq("assigned_rep", userId);
  if (accErr) throw accErr;

  /*
   * "Which records made this number?" is the whole job of a drill-through, so
   * it has to be built from the same set the number was. `leaderboard_standings`
   * now counts jobs with `AND NOT account_is_house_account(a.id)` — Mark:
   * "House accounts belong to the company rather than a rep" — and this list
   * did not, so the board said 6 and the panel underneath listed 8. The rule
   * lives in SQL for the count and here for the list because the count is an
   * RPC and this is not; both ask the same question of the same label.
   */
  const house = await fetchHouseAccountLabelsOrNone();
  const ids = (accounts ?? [])
    .map((a) => a.id as string)
    .filter((id) => countsTowardRep({ assigned_rep: userId, labels: house[id] ?? [] }));
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("jobs")
    .select("id,job_number,address,locality,insurance_carrier,insurance_kind,created_at,status")
    .in("account_id", ids)
    .gte("created_at", from.toISOString())
    .lt("created_at", to.toISOString())
    .neq("status", "cancelled")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;

  return ((data ?? []) as Record<string, unknown>[])
    .filter((j) => {
      const insured = Boolean(j.insurance_carrier) || Boolean(j.insurance_kind);
      return kind === "all" ? true : kind === "insurance" ? insured : !insured;
    })
    .map((j) => ({
      id: j.id as string,
      title: [j.address, j.locality].filter(Boolean).join(", ") || (j.job_number as string),
      subtitle: [
        j.job_number as string,
        j.insurance_carrier ? `Insurance · ${j.insurance_carrier as string}` : "Cash",
      ]
        .filter(Boolean)
        .join(" · "),
      at: j.created_at as string,
      href: `/jobs/${j.id as string}`,
    }));
}

export async function fetchDrill(
  metric: DrillMetric,
  userId: string,
  from: Date,
  to: Date,
): Promise<DrillRow[]> {
  if (metric === "jobs_insurance") return jobRows(userId, from, to, "insurance");
  if (metric === "jobs_cash") return jobRows(userId, from, to, "cash");
  if (metric === "jobs_total") return jobRows(userId, from, to, "all");

  if (metric === "advances") {
    const { data, error } = await supabase
      .from("account_stage_history")
      .select(
        "id,changed_at,account_id,from_stage_id,to_stage_id,accounts:account_id(name),from_stage:from_stage_id(name,sort_order),to_stage:to_stage_id(name,sort_order)",
      )
      .eq("changed_by", userId)
      .gte("changed_at", from.toISOString())
      .lt("changed_at", to.toISOString())
      .order("changed_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    type Stage = { name?: string; sort_order?: number } | null;
    return ((data ?? []) as Record<string, unknown>[])
      .filter((h) => {
        const f = h.from_stage as Stage;
        const t = h.to_stage as Stage;
        return (t?.sort_order ?? 0) > (f?.sort_order ?? 0);
      })
      .map((h) => ({
        id: h.id as string,
        title: ((h.accounts as { name?: string } | null)?.name ?? "Account") as string,
        subtitle: `${(h.from_stage as Stage)?.name ?? "—"} → ${(h.to_stage as Stage)?.name ?? "—"}`,
        at: h.changed_at as string,
        href: `/accounts/${h.account_id as string}`,
      }));
  }

  // Calls and meetings both come from touchpoints.
  let q = supabase
    .from("touchpoints")
    .select("id,type,occurred_at,notes,meeting_held,account_id,accounts:account_id(name)")
    .eq("created_by", userId)
    .gte("occurred_at", from.toISOString())
    .lt("occurred_at", to.toISOString())
    .order("occurred_at", { ascending: false })
    .limit(200);
  q = metric === "calls" ? q.eq("type", "call") : q.like("type", "meeting%");
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((t) => ({
    id: t.id as string,
    title: ((t.accounts as { name?: string } | null)?.name ?? "Account") as string,
    subtitle: ((t.notes as string) ?? (t.type as string)).slice(0, 120),
    at: t.occurred_at as string,
    href: t.account_id ? `/accounts/${t.account_id as string}` : undefined,
  }));
}
