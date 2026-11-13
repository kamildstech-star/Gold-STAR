import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { fetchActiveClients } from "@/lib/active-clients";
import {
  CRITICAL_LIST_PATH,
  fetchOpenCriticalEpisodes,
  isoDate,
  planCriticalSweep,
  recoveryTaskRow,
} from "@/lib/critical-clients";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * The nightly Critical step. Runs inside the cadence sweep, after the cadence
 * tasks, with the service-role client.
 *
 * It computes the board's verdict for every active client with the board's
 * own loader, then does the three things Melly listed for the day a client
 * goes Critical: a recovery task with a hard deadline, the manager's list
 * (the episode row), and — by the episode's existence — the leaderboard
 * exclusion. It closes an episode as recovered when the band has dropped,
 * which is the only way a rep clears one, and tells the managers each day a
 * day-30 decision is waiting.
 */

type Admin = SupabaseClient<Database>;

export type CriticalSweepResult = {
  opened: number;
  recovered: number;
  closed: number;
  decision_due: number;
  skipped?: string;
};

export async function runCriticalSweep(admin: Admin, now: Date): Promise<CriticalSweepResult> {
  const result: CriticalSweepResult = { opened: 0, recovered: 0, closed: 0, decision_due: 0 };

  let open;
  try {
    open = await fetchOpenCriticalEpisodes(admin);
  } catch (e) {
    if (isMissingSchema(e)) return { ...result, skipped: "client_critical_episodes not migrated" };
    throw e;
  }
  const rows = await fetchActiveClients(admin);
  const plan = planCriticalSweep({ rows, open, now: now.getTime() });
  const nowIso = now.toISOString();
  const managers = managerLookup(admin);

  for (const o of plan.open) {
    const { data: ep, error } = await admin
      .from("client_critical_episodes")
      .insert({
        account_id: o.account_id,
        assigned_rep: o.assigned_rep,
        location_id: o.location_id,
        track: o.track,
        reason: o.reason,
        opened_at: nowIso,
        deadline: o.deadline,
        is_demo: o.is_demo,
      })
      .select("id")
      .single();
    if (error || !ep) continue;
    result.opened += 1;

    if (o.assigned_rep) {
      const { data: task } = await admin
        .from("tasks")
        .insert(recoveryTaskRow(o, ep.id, o.assigned_rep))
        .select("id")
        .single();
      if (task) {
        await admin
          .from("client_critical_episodes")
          .update({ recovery_task_id: task.id })
          .eq("id", ep.id);
      }
      await admin.from("notifications").insert({
        user_id: o.assigned_rep,
        type: "automation_task",
        title: `Critical — ${o.name}`,
        body: `${o.reason}. Thirty days to recover it, until ${o.deadline}. Only a real acknowledged response clears it.`,
        entity_type: "account",
        entity_id: o.account_id,
        href: `/accounts/${o.account_id}`,
        priority: "high",
        is_demo: o.is_demo,
      });
    }

    const mgrs = await managers(o.location_id);
    if (mgrs.length) {
      await admin.from("notifications").insert(
        mgrs.map((user_id) => ({
          user_id,
          type: "automation_escalation" as const,
          title: `Client went Critical — ${o.name}`,
          body: `${o.track === "relationship" ? "Relationship" : "Compliance"}: ${o.reason}. On your Critical list with a deadline of ${o.deadline}.`,
          entity_type: "account",
          entity_id: o.account_id,
          href: CRITICAL_LIST_PATH,
          priority: "high" as const,
          is_demo: o.is_demo,
        })),
      );
    }
  }

  for (const ep of plan.recovered) {
    await admin
      .from("client_critical_episodes")
      .update({ resolved_at: nowIso, resolution: "recovered" })
      .eq("id", ep.id)
      .is("resolved_at", null);
    if (ep.recovery_task_id) {
      await admin
        .from("tasks")
        .update({ status: "done", completed_at: nowIso })
        .eq("id", ep.recovery_task_id)
        .in("status", ["open", "in_progress"]);
    }
    result.recovered += 1;
  }

  for (const ep of plan.closed) {
    await admin
      .from("client_critical_episodes")
      .update({ resolved_at: nowIso, resolution: "closed" })
      .eq("id", ep.id)
      .is("resolved_at", null);
    if (ep.recovery_task_id) {
      await admin
        .from("tasks")
        .update({ status: "cancelled" })
        .eq("id", ep.recovery_task_id)
        .in("status", ["open", "in_progress"]);
    }
    result.closed += 1;
  }

  // Day thirty. "The manager must pick one of four things, and the system will
  // not let them skip it or let it sit." The list itself holds the item until
  // a decision is made; this is the daily reminder that it is sitting there.
  if (plan.decisionDue.length) {
    const byId = new Map(open.map((e) => [e.id, e]));
    const names = new Map(rows.map((r) => [r.accountId, r.name]));
    const today = isoDate(now.getTime());
    for (const due of plan.decisionDue) {
      const ep = byId.get(due.id);
      if (!ep) continue;
      const mgrs = await managers(ep.location_id);
      if (!mgrs.length) continue;
      const name = names.get(ep.account_id) ?? "a client";
      await admin.from("notifications").insert(
        mgrs.map((user_id) => ({
          user_id,
          type: "automation_escalation" as const,
          title: `Day-30 decision due — ${name}`,
          body: `Still Critical past the ${ep.deadline} deadline (today ${today}). Extend, reassign, demote to Dormant or close as No Service Needed.`,
          entity_type: "account",
          entity_id: ep.account_id,
          href: CRITICAL_LIST_PATH,
          priority: "high" as const,
          is_demo: ep.is_demo,
        })),
      );
      result.decision_due += 1;
    }
  }

  return result;
}

/**
 * Who hears about a Critical client: the office's managers plus sales
 * leadership (same shape as the rep-nudge escalations).
 */
function managerLookup(admin: Admin) {
  const cache = new Map<string, string[]>();
  return async (locationId: string | null): Promise<string[]> => {
    const key = locationId ?? "none";
    const hit = cache.get(key);
    if (hit) return hit;
    const ids = new Set<string>();
    if (locationId) {
      const { data } = await admin
        .from("location_members")
        .select("user_id")
        .eq("location_id", locationId)
        .eq("role", "manager");
      for (const m of data ?? []) ids.add(m.user_id);
    }
    const { data: heads } = await admin
      .from("user_roles")
      .select("user_id")
      .in("role", ["sales_head", "sales_manager", "owner"]);
    for (const h of heads ?? []) ids.add(h.user_id);
    const list = [...ids];
    cache.set(key, list);
    return list;
  };
}
