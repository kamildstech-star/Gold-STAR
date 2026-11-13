/**
 * Rep nudges, pace alerts and idle-account flags.
 *
 * The point of this sweep is that a manager should never be the reminder
 * system. Anything a rep forgot — a meeting logged without notes, a deal with
 * no next activity, a stage sitting past its window, a chase with no outcome —
 * goes to the rep first. Only when the same nudge has been sent and ignored
 * `escalate_after` times does the manager hear about it.
 *
 * Nothing here contacts a client. Tasks, internal notifications and flags only,
 * and every nudge carries the reason it exists.
 */

import { isQuickGhosting } from "./pipeline-rules";

type SweepResult = {
  opened: number;
  renudged: number;
  escalated: number;
  resolved: number;
  paceAlerts: number;
  idleFlagged: number;
};

export type NudgeSettings = {
  /** Days a deal may sit with no next activity before the rep is nudged. */
  no_next_activity_days: number;
  /** Fallback stale-stage window when a stage has none configured. */
  stale_stage_days: number;
  /** Hours a chase may sit arrived-but-unresolved before the rep is nudged. */
  missing_outcome_hours: number;
  /** Days without a touch before an owned account is flagged for rotation. */
  idle_account_days: number;
  /** How many ignored nudges before the manager sees it. */
  escalate_after: number;
  /** Minimum hours between repeat nudges for the same thing. */
  renudge_hours: number;
  /** Attainment may trail the share of month elapsed by this much. */
  pace_gap: number;
};

export const NUDGE_DEFAULTS: NudgeSettings = {
  no_next_activity_days: 7,
  stale_stage_days: 21,
  missing_outcome_hours: 24,
  idle_account_days: 45,
  escalate_after: 2,
  renudge_hours: 48,
  pace_gap: 0.15,
};

const CLOSED_STAGES = ["lost", "no_service_needed", "goasted"];

type Candidate = {
  userId: string;
  kind: string;
  entityType: string;
  entityId: string;
  dedupe: string;
  title: string;
  reason: string;
  href: string;
  locationId: string | null;
  /** Escalate straight away rather than after N ignored nudges. */
  escalateNow?: boolean;
};

export async function runRepCoachingSweep(): Promise<SweepResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date();
  const result: SweepResult = {
    opened: 0,
    renudged: 0,
    escalated: 0,
    resolved: 0,
    paceAlerts: 0,
    idleFlagged: 0,
  };

  const { data: settingRow } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", "rep_nudges")
    .maybeSingle();
  const s: NudgeSettings = {
    ...NUDGE_DEFAULTS,
    ...((settingRow?.value as Partial<NudgeSettings> | null) ?? {}),
  };

  const since = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  const [
    { data: accounts },
    { data: windows },
    { data: stages },
    { data: openTasks },
    { data: recentTouches },
    { data: meetings },
    { data: incidents },
  ] = await Promise.all([
    supabaseAdmin
      .from("accounts")
      .select("id,name,location_id,assigned_rep,stage,stage_id,stage_changed_at,archived_at")
      .is("archived_at", null),
    supabaseAdmin
      .from("automation_stage_windows")
      .select("stage_id,rot_days")
      .eq("is_active", true),
    supabaseAdmin.from("pipeline_stages").select("id,name,is_won,is_lost"),
    supabaseAdmin.from("tasks").select("account_id,status").in("status", ["open", "in_progress"]),
    supabaseAdmin
      .from("touchpoints")
      .select("account_id,occurred_at")
      .gte("occurred_at", since(s.idle_account_days)),
    supabaseAdmin
      .from("touchpoints")
      .select("id,account_id,type,notes,created_by,occurred_at,meeting_held")
      .in("type", ["meeting_in_person", "meeting_virtual"])
      .gte("occurred_at", since(21)),
    supabaseAdmin
      .from("incidents")
      .select("id,address,accepted_by,arrived_at,outcome,location_id")
      .not("accepted_by", "is", null)
      .not("arrived_at", "is", null)
      .is("outcome", null)
      .gte("arrived_at", since(30)),
  ]);

  const rotByStage = new Map(
    ((windows ?? []) as { stage_id: string; rot_days: number | null }[]).map((w) => [
      w.stage_id,
      w.rot_days ?? s.stale_stage_days,
    ]),
  );
  const stageById = new Map(
    (
      (stages ?? []) as {
        id: string;
        name: string;
        is_won: boolean | null;
        is_lost: boolean | null;
      }[]
    ).map((st) => [st.id, st]),
  );
  const accountsWithOpenTask = new Set(
    ((openTasks ?? []) as { account_id: string | null }[])
      .map((t) => t.account_id)
      .filter((v): v is string => !!v),
  );
  const lastTouch = new Map<string, string>();
  for (const t of (recentTouches ?? []) as { account_id: string | null; occurred_at: string }[]) {
    if (!t.account_id) continue;
    const prev = lastTouch.get(t.account_id);
    if (!prev || t.occurred_at > prev) lastTouch.set(t.account_id, t.occurred_at);
  }

  const candidates: Candidate[] = [];

  // 1. Meetings logged without notes -------------------------------------
  for (const m of (meetings ?? []) as {
    id: string;
    account_id: string | null;
    notes: string | null;
    created_by: string | null;
  }[]) {
    if (!m.created_by || !m.account_id) continue;
    if ((m.notes ?? "").trim().length >= 10) continue;
    const acct = (accounts ?? []).find((a) => a.id === m.account_id);
    candidates.push({
      userId: m.created_by,
      kind: "meeting_notes",
      entityType: "touchpoint",
      entityId: m.id,
      dedupe: `meeting_notes:${m.id}`,
      title: `Meeting notes missing — ${acct?.name ?? "account"}`,
      reason: "A meeting was logged with no notes. Add what was discussed while it is fresh.",
      href: acct ? `/accounts/${acct.id}` : "/accounts",
      locationId: acct?.location_id ?? null,
    });
  }

  // 2. Deals with no next activity, and 3. stale stages -------------------
  for (const a of (accounts ?? []) as {
    id: string;
    name: string;
    location_id: string | null;
    assigned_rep: string | null;
    stage: string | null;
    stage_id: string | null;
    stage_changed_at: string | null;
  }[]) {
    if (!a.assigned_rep) continue;
    const stage = a.stage_id ? stageById.get(a.stage_id) : null;
    if (stage?.is_won || stage?.is_lost) continue;
    if (CLOSED_STAGES.includes(a.stage ?? "")) continue;

    const sittingDays = a.stage_changed_at
      ? Math.floor((now.getTime() - new Date(a.stage_changed_at).getTime()) / 86_400_000)
      : 0;

    if (!accountsWithOpenTask.has(a.id) && sittingDays >= s.no_next_activity_days) {
      candidates.push({
        userId: a.assigned_rep,
        kind: "no_next_activity",
        entityType: "account",
        entityId: a.id,
        dedupe: `no_next_activity:${a.id}`,
        title: `No next activity — ${a.name}`,
        reason: `This deal has had no open task for ${sittingDays} days. Book the next step.`,
        href: `/accounts/${a.id}`,
        locationId: a.location_id,
      });
    }

    const rot = a.stage_id
      ? (rotByStage.get(a.stage_id) ?? s.stale_stage_days)
      : s.stale_stage_days;
    if (a.stage_changed_at && sittingDays > rot) {
      candidates.push({
        userId: a.assigned_rep,
        kind: "stale_stage",
        entityType: "account",
        entityId: a.id,
        dedupe: `stale_stage:${a.id}:${a.stage_id ?? "none"}`,
        title: `Stalled in ${stage?.name ?? "stage"} — ${a.name}`,
        reason: `${sittingDays} days in this stage; the window is ${rot} days. Move it or say why not.`,
        href: `/accounts/${a.id}`,
        locationId: a.location_id,
      });
    }

    // 5. Idle-account rotation — flagged to the manager immediately.
    const touched = lastTouch.get(a.id);
    const idleDays = touched
      ? Math.floor((now.getTime() - new Date(touched).getTime()) / 86_400_000)
      : s.idle_account_days + 1;
    if (idleDays >= s.idle_account_days) {
      candidates.push({
        userId: a.assigned_rep,
        kind: "idle_account",
        entityType: "account",
        entityId: a.id,
        dedupe: `idle_account:${a.id}:${now.toISOString().slice(0, 7)}`,
        title: `Idle account — ${a.name}`,
        reason: touched
          ? `No touch in ${idleDays} days. Owner keeps it or the manager reassigns it.`
          : `No touch on record in the last ${s.idle_account_days} days.`,
        href: `/accounts/${a.id}`,
        locationId: a.location_id,
        escalateNow: true,
      });
      result.idleFlagged += 1;
    }
  }

  // 4. Chases with no outcome ---------------------------------------------
  for (const i of (incidents ?? []) as {
    id: string;
    address: string | null;
    accepted_by: string | null;
    arrived_at: string | null;
    location_id: string | null;
  }[]) {
    if (!i.accepted_by || !i.arrived_at) continue;
    const hours = (now.getTime() - new Date(i.arrived_at).getTime()) / 3_600_000;
    if (hours < s.missing_outcome_hours) continue;
    candidates.push({
      userId: i.accepted_by,
      kind: "missing_outcome",
      entityType: "incident",
      entityId: i.id,
      dedupe: `missing_outcome:${i.id}`,
      title: `Outcome missing — ${i.address ?? "chase"}`,
      reason: `You arrived ${Math.round(hours)} hours ago and no outcome was logged.`,
      href: "/chase",
      locationId: i.location_id,
    });
  }

  // 6. Ghosting after barely trying — straight to the manager --------------
  // Mark: "if a rep is ghosting a lot of records after barely trying, that
  // shows up for the manager." Every hand move into Ghosted is logged with the
  // attempt count at that moment (pipeline_ghost_events); the signal is reps
  // whose manual ghosts in the last 90 days mostly fell short of the outreach
  // standard. The rep is told too — it is their pattern to fix.
  {
    const { data: signal } = await supabaseAdmin.rpc("pipeline_manual_ghost_signal", {
      _days: 90,
      _min_attempts: undefined,
    });
    for (const row of signal ?? []) {
      if (!isQuickGhosting(row)) continue;
      const share = Math.round(Number(row.low_effort_share) * 100);
      candidates.push({
        userId: row.user_id,
        kind: "quick_ghosting",
        entityType: "user",
        entityId: row.user_id,
        dedupe: `quick_ghosting:${row.user_id}:${now.toISOString().slice(0, 7)}`,
        title: `Ghosting after barely trying — ${row.manual_ghosts} in 90 days`,
        reason: `${row.low_effort_ghosts} of ${row.manual_ghosts} records moved to Ghosted by hand (${share}%) had fewer attempts than the outreach standard asks for. Average ${row.avg_attempts} attempts.`,
        href: "/pipeline",
        locationId: null,
        escalateNow: true,
      });
    }
  }

  // ---- write nudges ------------------------------------------------------
  const { data: existingRows } = await supabaseAdmin
    .from("rep_nudges")
    .select(
      "id,user_id,dedupe_key,nudge_count,last_nudged_at,escalated_at,resolved_at,location_id,title,reason,entity_id,kind",
    );
  const existing = new Map(
    (
      (existingRows ?? []) as {
        id: string;
        user_id: string;
        dedupe_key: string;
        nudge_count: number;
        last_nudged_at: string;
        escalated_at: string | null;
        resolved_at: string | null;
      }[]
    ).map((r) => [`${r.user_id}:${r.dedupe_key}`, r]),
  );
  const stillTrue = new Set(candidates.map((c) => `${c.userId}:${c.dedupe}`));

  const managerCache = new Map<string, string[]>();
  async function managersFor(locationId: string | null): Promise<string[]> {
    const key = locationId ?? "none";
    const cached = managerCache.get(key);
    if (cached) return cached;
    const ids = new Set<string>();
    if (locationId) {
      const { data: members } = await supabaseAdmin
        .from("location_members")
        .select("user_id")
        .eq("location_id", locationId)
        .eq("role", "manager");
      for (const m of (members ?? []) as { user_id: string }[]) ids.add(m.user_id);
    }
    const { data: heads } = await supabaseAdmin
      .from("user_roles")
      .select("user_id,role")
      .in("role", ["sales_head", "owner"]);
    for (const h of (heads ?? []) as { user_id: string }[]) ids.add(h.user_id);
    const list = [...ids];
    managerCache.set(key, list);
    return list;
  }

  for (const c of candidates) {
    const key = `${c.userId}:${c.dedupe}`;
    const row = existing.get(key);

    if (!row) {
      const escalate = !!c.escalateNow;
      const { data: inserted } = await supabaseAdmin
        .from("rep_nudges")
        .insert({
          user_id: c.userId,
          kind: c.kind,
          entity_type: c.entityType,
          entity_id: c.entityId,
          dedupe_key: c.dedupe,
          title: c.title,
          reason: c.reason,
          href: c.href,
          location_id: c.locationId,
          nudge_count: 1,
          escalated_at: escalate ? now.toISOString() : null,
        })
        .select("id")
        .single();
      result.opened += 1;
      await supabaseAdmin.from("notifications").insert({
        user_id: c.userId,
        type: "rep_nudge",
        title: c.title,
        body: c.reason,
        entity_type: c.entityType,
        entity_id: c.entityId,
        href: c.href,
        priority: "normal",
      });
      if (escalate) {
        result.escalated += 1;
        for (const mgr of await managersFor(c.locationId)) {
          await supabaseAdmin.from("notifications").insert({
            user_id: mgr,
            type: "account_idle",
            title: c.title,
            body: `${c.reason} (nudge ${inserted?.id ?? ""})`,
            entity_type: c.entityType,
            entity_id: c.entityId,
            href: "/coaching/nudges",
            priority: "normal",
          });
        }
      }
      continue;
    }

    if (row.resolved_at) {
      await supabaseAdmin
        .from("rep_nudges")
        .update({ resolved_at: null, last_nudged_at: now.toISOString() })
        .eq("id", row.id);
      continue;
    }

    const hoursSince = (now.getTime() - new Date(row.last_nudged_at).getTime()) / 3_600_000;
    if (hoursSince < s.renudge_hours) continue;

    const nextCount = row.nudge_count + 1;
    const shouldEscalate = !row.escalated_at && nextCount > s.escalate_after;
    await supabaseAdmin
      .from("rep_nudges")
      .update({
        nudge_count: nextCount,
        last_nudged_at: now.toISOString(),
        escalated_at: shouldEscalate ? now.toISOString() : row.escalated_at,
      })
      .eq("id", row.id);
    result.renudged += 1;

    await supabaseAdmin.from("notifications").insert({
      user_id: c.userId,
      type: "rep_nudge",
      title: `${c.title} (reminder ${nextCount})`,
      body: c.reason,
      entity_type: c.entityType,
      entity_id: c.entityId,
      href: c.href,
      priority: shouldEscalate ? "high" : "normal",
    });

    if (shouldEscalate) {
      result.escalated += 1;
      for (const mgr of await managersFor(c.locationId)) {
        await supabaseAdmin.from("notifications").insert({
          user_id: mgr,
          type: "automation_escalation",
          title: `Ignored ${nextCount - 1}× — ${c.title}`,
          body: `${c.reason} The rep has been reminded ${nextCount - 1} times.`,
          entity_type: c.entityType,
          entity_id: c.entityId,
          href: "/coaching/nudges",
          priority: "high",
        });
      }
    }
  }

  // Anything no longer true closes itself — a nudge that outlives its reason
  // is noise, and noise is what gets the whole system ignored.
  for (const [key, row] of existing) {
    if (row.resolved_at || stillTrue.has(key)) continue;
    await supabaseAdmin
      .from("rep_nudges")
      .update({ resolved_at: now.toISOString() })
      .eq("id", row.id);
    result.resolved += 1;
  }

  result.paceAlerts = await runPaceAlerts(s, managersFor);
  return result;
}

/* ------------------------------------------------------------------ */
/* Goal pacing — mid-month, while there is still time to fix it        */
/* ------------------------------------------------------------------ */

async function runPaceAlerts(
  s: NudgeSettings,
  managersFor: (locationId: string | null) => Promise<string[]>,
): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const elapsed = (now.getTime() - start.getTime()) / (end.getTime() - start.getTime());
  // Too early to be meaningful, too late to be useful.
  if (elapsed < 0.25 || elapsed > 0.9) return 0;

  const monthKey = now.toISOString().slice(0, 7);
  const { data: goals } = await supabaseAdmin
    .from("goals")
    .select("id,subject_user_id,location_id,metric,target_value,period_type,starts_on,ends_on")
    .eq("is_active", true)
    .eq("period_type", "month")
    .lte("starts_on", end.toISOString().slice(0, 10))
    .gte("ends_on", start.toISOString().slice(0, 10))
    .not("subject_user_id", "is", null);
  if (!goals?.length) return 0;

  const from = start.toISOString();
  const to = now.toISOString();
  const userIds = [...new Set(goals.map((g) => g.subject_user_id!))];

  const [{ data: touches }, { data: history }, { data: newAccounts }, { data: jobs }] =
    await Promise.all([
      supabaseAdmin
        .from("touchpoints")
        .select("created_by")
        .gte("occurred_at", from)
        .lte("occurred_at", to),
      supabaseAdmin
        .from("account_stage_history")
        .select("changed_by,to_stage")
        .gte("changed_at", from)
        .lte("changed_at", to),
      supabaseAdmin
        .from("accounts")
        .select("assigned_rep")
        .gte("created_at", from)
        .lte("created_at", to),
      supabaseAdmin
        .from("jobs")
        .select("account_id,status,created_at")
        .gte("created_at", from)
        .lte("created_at", to),
    ]);

  const count = <T>(rows: T[] | null, pick: (r: T) => string | null) => {
    const out = new Map<string, number>();
    for (const r of rows ?? []) {
      const k = pick(r);
      if (!k) continue;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
    return out;
  };

  const touchCount = count(touches, (t) => (t as { created_by: string | null }).created_by);
  const advancedCount = count(history, (h) => (h as { changed_by: string | null }).changed_by);
  const meetingCount = count(
    (history ?? []).filter((h) => (h as { to_stage: string | null }).to_stage === "meeting_held"),
    (h) => (h as { changed_by: string | null }).changed_by,
  );
  const newAccountCount = count(
    newAccounts,
    (a) => (a as { assigned_rep: string | null }).assigned_rep,
  );

  const { data: accountOwners } = await supabaseAdmin.from("accounts").select("id,assigned_rep");
  const ownerByAccount = new Map(
    ((accountOwners ?? []) as { id: string; assigned_rep: string | null }[]).map((a) => [
      a.id,
      a.assigned_rep,
    ]),
  );
  const jobsWonCount = count(
    (jobs ?? []).filter((j) => (j as { status: string }).status !== "cancelled"),
    (j) => ownerByAccount.get((j as { account_id: string | null }).account_id ?? "") ?? null,
  );

  const actualFor = (metric: string, userId: string): number | null => {
    switch (metric) {
      case "touchpoints":
        return touchCount.get(userId) ?? 0;
      case "meetings_held":
        return meetingCount.get(userId) ?? 0;
      case "accounts_advanced":
        return advancedCount.get(userId) ?? 0;
      case "new_accounts":
        return newAccountCount.get(userId) ?? 0;
      case "jobs_won":
        return jobsWonCount.get(userId) ?? 0;
      default:
        // Money metrics are deliberately not alerted on: a rep never sees a
        // dollar figure until it is collected.
        return null;
    }
  };

  const byUser = new Map<string, { ratios: number[]; locationId: string | null }>();
  for (const g of goals) {
    const uid = g.subject_user_id!;
    const actual = actualFor(g.metric, uid);
    const target = Number(g.target_value);
    if (actual == null || !(target > 0)) continue;
    const entry = byUser.get(uid) ?? { ratios: [], locationId: g.location_id ?? null };
    entry.ratios.push(actual / target);
    byUser.set(uid, entry);
  }

  let sent = 0;
  for (const [uid, entry] of byUser) {
    if (!entry.ratios.length) continue;
    const attainment = entry.ratios.reduce((a, b) => a + b, 0) / entry.ratios.length;
    if (attainment >= elapsed - s.pace_gap) continue;

    const dedupe = `pace:${monthKey}`;
    const { data: already } = await supabaseAdmin
      .from("rep_nudges")
      .select("id")
      .eq("user_id", uid)
      .eq("dedupe_key", dedupe)
      .maybeSingle();
    if (already) continue;

    const pct = Math.round(attainment * 100);
    const elapsedPct = Math.round(elapsed * 100);
    const title = "Behind pace this month";
    const reason = `${pct}% of goal with ${elapsedPct}% of the month gone. There is still time.`;

    await supabaseAdmin.from("rep_nudges").insert({
      user_id: uid,
      kind: "goal_pace",
      entity_type: "goal",
      entity_id: null,
      dedupe_key: dedupe,
      title,
      reason,
      href: "/goals",
      location_id: entry.locationId,
      escalated_at: new Date().toISOString(),
    });
    await supabaseAdmin.from("notifications").insert({
      user_id: uid,
      type: "goal_pace",
      title,
      body: reason,
      entity_type: "goal",
      href: "/goals",
      priority: "normal",
    });
    for (const mgr of await managersFor(entry.locationId)) {
      await supabaseAdmin.from("notifications").insert({
        user_id: mgr,
        type: "goal_pace",
        title: "A rep has dropped under pace",
        body: reason,
        entity_type: "goal",
        href: "/coaching/nudges",
        priority: "normal",
      });
    }
    sent += 1;
  }

  return sent;
}
