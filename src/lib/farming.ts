import { supabase } from "@/integrations/supabase/client";
import {
  IN_PERSON_INTERVAL_DAYS,
  TOUCH_INTERVAL_DAYS,
  cadenceHealth,
  type CadenceHealth,
} from "@/lib/accounts";
import { OPEN_JOB_STATUSES } from "@/lib/jobs";

/**
 * "Farming" is the client's own word for the post-sale motion: you don't
 * close a referral source once, you work it forever. The table is sorted by
 * who is most overdue, because that is the only question the rep is asking.
 */

export type FarmRow = {
  id: string;
  name: string;
  accountType: string | null;
  ownerId: string | null;
  ownerName: string;
  locationId: string | null;
  locationName: string;
  health: CadenceHealth;
  lastTouchAt: string | null;
  lastTouchDays: number | null;
  nextTouchDue: string | null;
  /** Days past due; negative means still ahead of the cadence. */
  nextTouchOverdueDays: number | null;
  lastInPersonAt: string | null;
  annualDueOn: string | null;
  annualOverdueDays: number | null;
  openJobs: number;
  revenueCents: number;
  labels: { id: string; name: string; color: string | null }[];
  /** Sorting key: most overdue first. */
  urgency: number;
};

const DAY = 86400000;

function addDays(iso: string, days: number) {
  return new Date(new Date(iso).getTime() + days * DAY).toISOString();
}

function overdueDays(dueIso: string | null): number | null {
  if (!dueIso) return null;
  return Math.floor((Date.now() - new Date(dueIso).getTime()) / DAY);
}

export async function fetchFarmRows(): Promise<FarmRow[]> {
  const { data: accounts, error } = await supabase
    .from("accounts")
    .select(
      "id,name,account_type,status,assigned_rep,location_id,last_in_person_at,annual_meeting_due_on",
    )
    .is("archived_at", null)
    .order("name");
  if (error) throw error;

  const rows = (accounts ?? []) as Record<string, string | null>[];
  const ids = rows.map((a) => String(a.id));
  if (ids.length === 0) return [];

  const [touchRes, jobRes, invRes, profileRes, locRes, tagRes] = await Promise.all([
    supabase
      .from("touchpoints")
      .select("account_id,type,occurred_at,counts_toward_cadence")
      .in("account_id", ids)
      .order("occurred_at", { ascending: false })
      .limit(5000),
    supabase.from("jobs").select("account_id,status").in("account_id", ids).limit(5000),
    supabase
      .from("invoices")
      .select("account_id,collected_amount")
      .in("account_id", ids)
      .limit(5000),
    supabase.from("profiles").select("user_id,full_name"),
    supabase.from("locations").select("id,code,name"),
    supabase
      .from("account_tags")
      .select("account_id,tags(id,name,color)")
      .in("account_id", ids)
      .limit(5000),
  ]);

  const lastTouch = new Map<string, string>();
  const lastInPerson = new Map<string, string>();
  for (const t of (touchRes.data ?? []) as Record<string, string | boolean | null>[]) {
    const acc = String(t.account_id);
    const at = String(t.occurred_at);
    if (t.counts_toward_cadence !== false && !lastTouch.has(acc)) lastTouch.set(acc, at);
    if (String(t.type) === "meeting_in_person" && !lastInPerson.has(acc)) lastInPerson.set(acc, at);
  }

  const openJobs = new Map<string, number>();
  for (const j of (jobRes.data ?? []) as Record<string, string>[]) {
    if (!j.account_id) continue;
    if (!OPEN_JOB_STATUSES.includes(j.status as never)) continue;
    openJobs.set(j.account_id, (openJobs.get(j.account_id) ?? 0) + 1);
  }

  const revenue = new Map<string, number>();
  for (const i of (invRes.data ?? []) as Record<string, string | number | null>[]) {
    if (!i.account_id) continue;
    const acc = String(i.account_id);
    revenue.set(acc, (revenue.get(acc) ?? 0) + Math.round(Number(i.collected_amount ?? 0) * 100));
  }

  const names = new Map(
    ((profileRes.data ?? []) as { user_id: string; full_name: string | null }[]).map((p) => [
      p.user_id,
      p.full_name ?? "—",
    ]),
  );
  const locs = new Map(
    ((locRes.data ?? []) as { id: string; code: string | null; name: string }[]).map((l) => [
      l.id,
      l.code ?? l.name,
    ]),
  );

  const labels = new Map<string, { id: string; name: string; color: string | null }[]>();
  for (const t of (tagRes.data ?? []) as {
    account_id: string;
    tags: { id: string; name: string; color: string | null } | null;
  }[]) {
    if (!t.tags) continue;
    const list = labels.get(t.account_id) ?? [];
    list.push(t.tags);
    labels.set(t.account_id, list);
  }

  return rows.map((a) => {
    const id = String(a.id);
    const lt = lastTouch.get(id) ?? null;
    const ip = lastInPerson.get(id) ?? a.last_in_person_at ?? null;
    const nextTouchDue = lt ? addDays(lt, TOUCH_INTERVAL_DAYS) : null;
    const annualDue =
      a.annual_meeting_due_on ?? (ip ? addDays(ip, IN_PERSON_INTERVAL_DAYS).slice(0, 10) : null);
    const touchOverdue = nextTouchDue ? overdueDays(nextTouchDue) : 9999;
    const annualOverdue = annualDue ? overdueDays(`${annualDue}T00:00:00`) : null;

    return {
      id,
      name: String(a.name),
      accountType: a.account_type ?? null,
      ownerId: a.assigned_rep ?? null,
      ownerName: a.assigned_rep ? (names.get(a.assigned_rep) ?? "—") : "Unassigned",
      locationId: a.location_id ?? null,
      locationName: a.location_id ? (locs.get(a.location_id) ?? "—") : "—",
      health: cadenceHealth(lt, ip),
      lastTouchAt: lt,
      lastTouchDays: lt ? Math.floor((Date.now() - new Date(lt).getTime()) / DAY) : null,
      nextTouchDue,
      nextTouchOverdueDays: touchOverdue,
      lastInPersonAt: ip,
      annualDueOn: annualDue,
      annualOverdueDays: annualOverdue,
      openJobs: openJobs.get(id) ?? 0,
      revenueCents: revenue.get(id) ?? 0,
      labels: labels.get(id) ?? [],
      urgency: touchOverdue ?? -9999,
    } satisfies FarmRow;
  });
}

export const FARM_HEALTH_TONE: Record<CadenceHealth, string> = {
  overdue: "bg-destructive/10 text-destructive border-destructive/30",
  never: "bg-muted text-muted-foreground border-border",
  due_soon: "bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400",
  healthy: "bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-400",
};

export function overdueLabel(days: number | null): string {
  if (days == null) return "—";
  if (days >= 9999) return "Never touched";
  if (days > 0) return `${days}d overdue`;
  if (days === 0) return "Due today";
  return `in ${Math.abs(days)}d`;
}
