// Automation engine core — shared by the manual "Run now" server function,
// the every-15-minutes cron hook and the event-driven database triggers.
// Runs with the service role because it must see every account in scope;
// every action it takes is written to automation_runs / automation_events so
// a rule firing can always be proven and explained.
//
// Nothing in here can contact a client. Only tasks, notifications, stage
// moves, flags and escalations — all internal. A job rule may also email
// STAFF (automation-jobs.server.ts), resolved from a role or a named person,
// queued until outbound email is switched on.

import { normalizeAction } from "./automation";
import type { RuleAction, RuleConditions, RuleTriggerConfig, TriggerType } from "./automation";
import { loadClientHealthSettings } from "./client-health";

type Json = Record<string, unknown>;

function daysBetween(from: string | null, to: Date): number {
  if (!from) return 0;
  return Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000);
}

function isoDatePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export type EngineOptions = {
  ruleId?: string | null;
  /** Only evaluate rules with these trigger types (event-driven runs). */
  triggerTypes?: TriggerType[];
  /** User the run is attributed to; null for scheduled/system runs. */
  triggeredBy?: string | null;
};

export type EngineResult = {
  rules: number;
  actions: number;
  summaries: { rule: string; matched: number; actions: number }[];
};

export async function runAutomationEngine(opts: EngineOptions = {}): Promise<EngineResult> {
  const now = new Date();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  let rulesQ = supabaseAdmin
    .from("automation_rules")
    .select("*")
    .eq("is_active", true)
    .order("run_order");
  if (opts.ruleId) rulesQ = rulesQ.eq("id", opts.ruleId);
  if (opts.triggerTypes?.length) rulesQ = rulesQ.in("trigger_type", opts.triggerTypes as never);
  const { data: rules, error: rulesErr } = await rulesQ;
  if (rulesErr) throw rulesErr;

  const [{ data: windows }, { data: stages }, { data: salesHeads }] = await Promise.all([
    supabaseAdmin.from("automation_stage_windows").select("*").eq("is_active", true),
    supabaseAdmin.from("pipeline_stages").select("id, name, pipeline_id, is_won, is_lost"),
    supabaseAdmin.from("user_roles").select("user_id, role").in("role", ["sales_head", "owner"]),
  ]);
  const windowByStage = new Map((windows ?? []).map((w) => [w.stage_id, w]));
  const stageById = new Map((stages ?? []).map((s) => [s.id, s]));
  // A no_activity rule with no day count of its own follows the client-health
  // at-risk threshold, so "flag at-risk clients" means the same thing here as
  // on the Active Clients board.
  const clientHealth = await loadClientHealthSettings(supabaseAdmin);
  const headIds = [...new Set((salesHeads ?? []).map((r) => r.user_id))];

  let totalActions = 0;
  const summaries: { rule: string; matched: number; actions: number }[] = [];

  for (const rule of rules ?? []) {
    const { data: run } = await supabaseAdmin
      .from("automation_runs")
      .insert({ rule_id: rule.id, triggered_by: opts.triggeredBy ?? null })
      .select()
      .single();

    try {
      const cfg = (rule.trigger_config ?? {}) as RuleTriggerConfig;
      const cond = (rule.conditions ?? {}) as RuleConditions;
      const actions: RuleAction[] = (Array.isArray(rule.actions) ? rule.actions : [])
        .map(normalizeAction)
        .filter((a) => Boolean(a.kind));

      /*
       * Job rules have their own candidates (jobs, not accounts), their own
       * recipients and an email action. Same rule row, same run and event
       * log — see automation-jobs.server.ts.
       */
      if ((rule.trigger_type as TriggerType) === "job_stage_age") {
        const { runJobStageRule } = await import("./automation-jobs.server");
        const res = await runJobStageRule({
          db: supabaseAdmin,
          rule,
          actions,
          runId: run?.id ?? null,
          triggeredBy: opts.triggeredBy ?? null,
          now,
        });
        totalActions += res.actions;
        summaries.push({ rule: rule.name, matched: res.matched, actions: res.actions });
        if (run) {
          await supabaseAdmin
            .from("automation_runs")
            .update({
              finished_at: new Date().toISOString(),
              evaluated_count: res.evaluated,
              matched_count: res.matched,
              action_count: res.actions,
            })
            .eq("id", run.id);
        }
        continue;
      }

      // ----- gather candidates -----
      // date_reached rules read whichever column their date_field names, so the
      // deprecated goasted_at stays in the list for any rule saved before the
      // spelling fix. New rules use ghosted_at (see DATE_FIELDS).
      let accountsQ = supabaseAdmin
        .from("accounts")
        .select(
          "id, name, location_id, assigned_rep, pipeline_id, stage_id, stage_changed_at, account_type, annual_meeting_due_on, reactivate_on, approval_due_on, ghosted_at, goasted_at, created_at",
        );
      if (rule.location_id) accountsQ = accountsQ.eq("location_id", rule.location_id);
      if (cond.pipeline_id) accountsQ = accountsQ.eq("pipeline_id", cond.pipeline_id);
      if (cond.stage_ids?.length) accountsQ = accountsQ.in("stage_id", cond.stage_ids);
      if (cond.owner_ids?.length) accountsQ = accountsQ.in("assigned_rep", cond.owner_ids);
      if (cond.account_types?.length)
        accountsQ = accountsQ.in("account_type", cond.account_types as never);
      const { data: accounts } = await accountsQ;

      type Match = {
        id: string;
        label: string;
        locationId: string | null;
        ownerId: string | null;
        reason: string;
        dedupe: string;
        escalate: boolean;
      };
      const matches: Match[] = [];

      if (rule.trigger_type === "stage_rot") {
        for (const a of accounts ?? []) {
          if (!a.stage_id) continue;
          const w = windowByStage.get(a.stage_id);
          const rotDays = w?.rot_days ?? cfg.days ?? 14;
          const escDays = w?.escalate_days ?? null;
          const sitting = daysBetween(a.stage_changed_at, now);
          if (sitting < rotDays) continue;
          const stageName = stageById.get(a.stage_id)?.name ?? "this stage";
          const escalate = escDays != null && sitting >= escDays;
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: `No movement for ${sitting} days in ${stageName} — that stage rots after ${rotDays} days.`,
            dedupe: `rot:${a.stage_id}:${escalate ? "escalate" : "first"}`,
            escalate,
          });
        }
      } else if (rule.trigger_type === "no_activity") {
        const days = cfg.days && cfg.days > 0 ? cfg.days : clientHealth.at_risk_after_days;
        const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
        const { data: recent } = await supabaseAdmin
          .from("touchpoints")
          .select("account_id")
          .gte("occurred_at", cutoff)
          .eq("counts_toward_cadence", true);
        const active = new Set((recent ?? []).map((t) => t.account_id));
        for (const a of accounts ?? []) {
          if (active.has(a.id)) continue;
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: `No qualifying touch point on this account in the last ${days} days.`,
            dedupe: `noact:${days}:${now.toISOString().slice(0, 7)}`,
            escalate: false,
          });
        }
      } else if (rule.trigger_type === "date_reached") {
        const field = cfg.date_field ?? "annual_meeting_due_on";
        const offset = cfg.offset_days ?? 0;
        for (const a of accounts ?? []) {
          const raw = (a as unknown as Json)[field] as string | null;
          if (!raw) continue;
          const due = new Date(raw);
          due.setDate(due.getDate() + offset);
          if (due > now) continue;
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: `${field.replace(/_/g, " ")} reached (${raw}).`,
            dedupe: `date:${field}:${raw}`,
            escalate: false,
          });
        }
      } else if (rule.trigger_type === "deal_won" || rule.trigger_type === "deal_lost") {
        const wantWon = rule.trigger_type === "deal_won";
        for (const a of accounts ?? []) {
          const s = a.stage_id ? stageById.get(a.stage_id) : null;
          if (!s) continue;
          if (wantWon ? !s.is_won : !s.is_lost) continue;
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: `Deal marked ${wantWon ? "won" : "lost"} in ${s.name}.`,
            dedupe: `${rule.trigger_type}:${a.stage_id}:${a.stage_changed_at ?? ""}`,
            escalate: false,
          });
        }
      } else if (rule.trigger_type === "deal_created") {
        const days = cfg.days ?? 1;
        const cutoff = new Date(now.getTime() - days * 86_400_000);
        for (const a of accounts ?? []) {
          if (new Date(a.created_at) < cutoff) continue;
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: "Deal created.",
            dedupe: `created:${a.id}`,
            escalate: false,
          });
        }
      } else if (rule.trigger_type === "stage_enter" || rule.trigger_type === "stage_leave") {
        const days = cfg.days ?? 1;
        const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
        const { data: history } = await supabaseAdmin
          .from("account_stage_history")
          .select("account_id, from_stage_id, to_stage_id, changed_at")
          .gte("changed_at", cutoff);
        const byId = new Map((accounts ?? []).map((a) => [a.id, a]));
        for (const h of history ?? []) {
          const a = byId.get(h.account_id);
          if (!a) continue;
          const stageId = rule.trigger_type === "stage_enter" ? h.to_stage_id : h.from_stage_id;
          if (!stageId) continue;
          if (cond.stage_ids?.length && !cond.stage_ids.includes(stageId)) continue;
          const stageName = stageById.get(stageId)?.name ?? "a stage";
          matches.push({
            id: a.id,
            label: a.name,
            locationId: a.location_id,
            ownerId: a.assigned_rep,
            reason: `Deal ${rule.trigger_type === "stage_enter" ? "entered" : "left"} ${stageName}.`,
            dedupe: `${rule.trigger_type}:${stageId}:${h.changed_at}`,
            escalate: false,
          });
        }
      } else if (rule.trigger_type === "task_past_due") {
        const days = cfg.days ?? 0;
        const cutoff = isoDatePlus(-days);
        let tasksQ = supabaseAdmin
          .from("tasks")
          .select("id, title, assignee, location_id, due_date, status")
          .in("status", ["open", "in_progress"])
          .lt("due_date", cutoff);
        if (rule.location_id) tasksQ = tasksQ.eq("location_id", rule.location_id);
        const { data: overdue } = await tasksQ;
        for (const t of overdue ?? []) {
          matches.push({
            id: t.id,
            label: t.title,
            locationId: t.location_id,
            ownerId: t.assignee,
            reason: `Task has been past due since ${t.due_date}.`,
            dedupe: `pastdue:${t.due_date}:${days}`,
            escalate: true,
          });
        }
      }

      // ----- apply actions -----
      const recordType = rule.trigger_type === "task_past_due" ? "task" : "account";
      let actionCount = 0;

      for (const m of matches) {
        for (const action of actions) {
          const dedupe = `${m.dedupe}:${action.kind}`;
          const { data: existing } = await supabaseAdmin
            .from("automation_events")
            .select("id")
            .eq("rule_id", rule.id)
            .eq("record_id", m.id)
            .eq("dedupe_key", dedupe)
            .maybeSingle();
          if (existing) continue;

          const targetUser =
            action.assignee_mode === "specific"
              ? (action.assignee_user_id ?? null)
              : action.assignee_mode === "sales_head"
                ? (headIds[0] ?? null)
                : m.ownerId;

          let taskId: string | null = null;

          if (action.kind === "create_task" || action.kind === "assign_task") {
            const { data: task } = await supabaseAdmin
              .from("tasks")
              .insert({
                title: action.title || `${rule.name}: ${m.label}`,
                description: action.description ?? null,
                assignee: targetUser,
                due_date: isoDatePlus(action.due_in_days ?? 1),
                priority: action.priority ?? "normal",
                status: "open",
                entity_type: recordType,
                entity_id: m.id,
                account_id: recordType === "account" ? m.id : null,
                location_id: m.locationId,
                source: "automation",
                automation_rule_id: rule.id,
                automation_reason: m.reason,
                created_by: opts.triggeredBy ?? targetUser ?? null,
              })
              .select("id")
              .single();
            taskId = task?.id ?? null;
            if (targetUser) {
              await supabaseAdmin.from("notifications").insert({
                user_id: targetUser,
                type: "automation_task",
                title: action.title || `${rule.name}: ${m.label}`,
                body: `${m.reason} (rule: ${rule.name})`,
                entity_type: "task",
                entity_id: taskId,
                href: "/tasks",
                priority: "normal",
              });
            }
          } else if (action.kind === "set_due_date" && recordType === "task") {
            await supabaseAdmin
              .from("tasks")
              .update({ due_date: isoDatePlus(action.due_in_days ?? 1) })
              .eq("id", m.id);
          } else if (action.kind === "notify") {
            if (targetUser) {
              await supabaseAdmin.from("notifications").insert({
                user_id: targetUser,
                type: "automation_task",
                title: `${rule.name}: ${m.label}`,
                body: action.message ? `${action.message} — ${m.reason}` : m.reason,
                entity_type: recordType,
                entity_id: m.id,
                href: recordType === "account" ? `/accounts/${m.id}` : "/tasks",
                priority: "normal",
              });
            }
          } else if (action.kind === "move_stage" && action.stage_id && recordType === "account") {
            await supabaseAdmin
              .from("accounts")
              .update({ stage_id: action.stage_id, stage_changed_at: new Date().toISOString() })
              .eq("id", m.id);
          } else if (action.kind === "apply_flag" && recordType === "account") {
            const { error: flagErr } = await supabaseAdmin
              .from("accounts")
              .update({ priority: action.flag ?? "high" })
              .eq("id", m.id);
            if (flagErr) throw flagErr;
          } else if (action.kind === "escalate") {
            if (!m.escalate && rule.trigger_type === "stage_rot") continue;
            for (const head of headIds) {
              await supabaseAdmin.from("notifications").insert({
                user_id: head,
                type: "automation_escalation",
                title: `Escalation — ${m.label}`,
                body: `${m.reason} (rule: ${rule.name})`,
                entity_type: recordType,
                entity_id: m.id,
                href: recordType === "account" ? `/accounts/${m.id}` : "/tasks",
                priority: "high",
              });
            }
          }

          const { error: eventErr } = await supabaseAdmin.from("automation_events").insert({
            rule_id: rule.id,
            run_id: run?.id ?? null,
            record_type: recordType,
            record_id: m.id,
            record_label: m.label,
            action_kind: action.kind as never,
            reason: m.reason,
            task_id: taskId,
            target_user_id: targetUser,
            location_id: m.locationId,
            dedupe_key: dedupe,
          });
          actionCount += 1;
        }
      }

      totalActions += actionCount;
      summaries.push({ rule: rule.name, matched: matches.length, actions: actionCount });

      if (run) {
        await supabaseAdmin
          .from("automation_runs")
          .update({
            finished_at: new Date().toISOString(),
            evaluated_count: (accounts ?? []).length,
            matched_count: matches.length,
            action_count: actionCount,
          })
          .eq("id", run.id);
      }
    } catch (err) {
      // A broken rule must not stop the others, and the failure has to be
      // visible in the run history rather than swallowed.
      const message = err instanceof Error ? err.message : String(err);
      summaries.push({ rule: rule.name, matched: 0, actions: 0 });
      if (run) {
        await supabaseAdmin
          .from("automation_runs")
          .update({ finished_at: new Date().toISOString(), error: message })
          .eq("id", run.id);
      }
    }
  }

  return { rules: (rules ?? []).length, actions: totalActions, summaries };
}
