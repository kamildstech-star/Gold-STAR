// Automatic stage progression — evaluation.
//
// Runs as the signed-in user, so it can only ever move records that user can
// already see and edit. Every automatic move is written to stage history with
// the conditions that caused it, so the timeline can say
// "(Automation: meeting scheduled)".

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { AdvanceCondition } from "./stage-advance";

function describe(c: AdvanceCondition): string {
  if (c.kind === "activity_logged")
    return `${(c.activity_type ?? "any") === "any" ? "activity" : c.activity_type} logged`;
  if (c.kind === "meeting_scheduled") return "meeting scheduled";
  if (c.kind === "document_signed") return "document signed";
  return `${c.field ?? "field"} populated`;
}

export const runStageAdvance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { accountId?: string | null } | undefined) => input ?? {})
  .handler(async ({ data, context }) => {
    const { supabase } = context;

    const { data: stages, error: stagesErr } = await supabase
      .from("pipeline_stages")
      .select("id,name,pipeline_id,auto_advance,advance_to_stage_id,advance_conditions,sort_order")
      .eq("is_active", true);
    if (stagesErr) throw stagesErr;

    const stageById = new Map((stages ?? []).map((s) => [s.id, s]));
    const armed = (stages ?? []).filter(
      (s) => s.auto_advance && Array.isArray(s.advance_conditions) && s.advance_conditions.length,
    );
    if (!armed.length)
      return { moved: 0, moves: [] as { account: string; to: string; reason: string }[] };

    let accQ = supabase
      .from("accounts")
      .select(
        "id,name,stage_id,stage_changed_at,pipeline_id,phone,email,website,address_line1,estimated_annual_value,account_type_id,assigned_rep",
      )
      .in(
        "stage_id",
        armed.map((s) => s.id),
      )
      .is("archived_at", null);
    if (data.accountId) accQ = accQ.eq("id", data.accountId);
    const { data: accounts, error: accErr } = await accQ;
    if (accErr) throw accErr;
    if (!accounts?.length) return { moved: 0, moves: [] };

    const ids = accounts.map((a) => a.id);
    const [{ data: touchpoints }, { data: events }, { data: docs }] = await Promise.all([
      supabase.from("touchpoints").select("account_id,type,occurred_at").in("account_id", ids),
      supabase
        .from("calendar_events")
        .select("account_id,starts_at,is_cancelled,created_at")
        .in("account_id", ids),
      supabase.from("documents").select("account_id,status,signed_at").in("account_id", ids),
    ]);

    const moves: { account: string; to: string; reason: string }[] = [];

    for (const a of accounts) {
      const stage = a.stage_id ? stageById.get(a.stage_id) : null;
      if (!stage) continue;
      const target = stage.advance_to_stage_id
        ? stageById.get(stage.advance_to_stage_id)
        : (stages ?? [])
            .filter((s) => s.pipeline_id === stage.pipeline_id && s.sort_order > stage.sort_order)
            .sort((x, y) => x.sort_order - y.sort_order)[0];
      if (!target || target.id === stage.id) continue;

      const since = a.stage_changed_at ? new Date(a.stage_changed_at).getTime() : 0;
      const conditions = (stage.advance_conditions ?? []) as unknown as AdvanceCondition[];

      const met = conditions.every((c) => {
        if (c.kind === "activity_logged") {
          const want = c.activity_type ?? "any";
          const n = (touchpoints ?? []).filter(
            (t) =>
              t.account_id === a.id &&
              (want === "any" || t.type === want) &&
              new Date(t.occurred_at).getTime() >= since,
          ).length;
          return n >= (c.min_count ?? 1);
        }
        if (c.kind === "meeting_scheduled") {
          return (events ?? []).some(
            (e) =>
              e.account_id === a.id &&
              !e.is_cancelled &&
              new Date(e.created_at ?? e.starts_at).getTime() >= since,
          );
        }
        if (c.kind === "document_signed") {
          return (docs ?? []).some(
            (d) =>
              d.account_id === a.id &&
              d.status === "signed" &&
              (!d.signed_at || new Date(d.signed_at).getTime() >= since),
          );
        }
        const v = (a as unknown as Record<string, unknown>)[c.field ?? ""];
        return v !== null && v !== undefined && String(v).trim() !== "";
      });
      if (!met) continue;

      const reason = `Automation: ${conditions.map(describe).join(", ")}`;
      const now = new Date().toISOString();

      const { error: upErr } = await supabase
        .from("accounts")
        .update({ stage_id: target.id, stage_changed_at: now })
        .eq("id", a.id)
        .eq("stage_id", stage.id);
      if (upErr) continue;

      // A database trigger already records the move; stamp the reason onto it
      // so the timeline shows what caused the automatic advance.
      const { data: hist } = await supabase
        .from("account_stage_history")
        .select("id")
        .eq("account_id", a.id)
        .eq("to_stage_id", target.id)
        .order("changed_at", { ascending: false })
        .limit(1);
      if (hist?.[0]) {
        await supabase.from("account_stage_history").update({ reason }).eq("id", hist[0].id);
      }

      moves.push({ account: a.name, to: target.name, reason });
    }

    return { moved: moves.length, moves };
  });
