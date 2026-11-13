import { useEffect, useState } from "react";
import { Target, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { useGoalProgress, type GoalProgress } from "@/lib/goal-progress";
import { GOAL_METRICS, setGoalWhy, type GoalPeriod } from "@/lib/goals";
import { pct } from "@/lib/leaderboard";
import { cn } from "@/lib/utils";
import { FitText } from "@/components/ui/fit-text";

/**
 * The one goal widget.
 *
 * The dashboard and the My Goals tab both render this, over the same hook, so
 * the number a rep sees cannot differ by screen. The "why" is the point of the
 * feature: it is shown at all times and moved to the top, in full, the moment
 * attainment falls behind the share of the period already spent.
 */

function Bar({ ratio }: { ratio: number | null }) {
  if (ratio == null) return <div className="h-1.5 w-full rounded-full bg-muted" />;
  const w = Math.max(0, Math.min(1, ratio));
  return (
    <div className="h-1.5 w-full rounded-full bg-muted">
      <div
        className={cn(
          "h-full rounded-full",
          ratio >= 1 ? "bg-success" : ratio >= 0.6 ? "bg-brand-gold" : "bg-brand",
        )}
        style={{ width: `${w * 100}%` }}
      />
    </div>
  );
}

function WhyBlock({
  why,
  behind,
  canEdit,
  onEdit,
}: {
  why: string | null;
  behind: boolean;
  canEdit: boolean;
  onEdit: () => void;
}) {
  if (!why) {
    return canEdit ? (
      <button
        type="button"
        onClick={onEdit}
        className="w-full rounded-md bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] px-3 py-2 text-left text-[12px] text-muted-foreground hover:bg-[#FCF3D7] dark:hover:bg-[color-mix(in_oklab,var(--warning)_24%,var(--card))]"
      >
        What are you working toward? Write your why — it shows here, and loudest when you are
        behind.
      </button>
    ) : null;
  }
  return (
    <div
      className={cn(
        "rounded-md bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] px-3 py-2",
        behind && "ring-1 ring-brand-gold",
      )}
    >
      <div className="mb-0.5 flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wide text-brand-gold">
          {behind ? "Why you started" : "My why"}
        </span>
        {behind && (
          <Badge variant="destructive" className="h-4 px-1.5 text-[9px] font-bold uppercase">
            Behind pace
          </Badge>
        )}
        {canEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="ml-auto text-muted-foreground hover:text-foreground"
            aria-label="Edit my why"
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
      </div>
      <p className={cn("text-[13px] leading-snug", behind ? "font-medium" : "text-foreground/90")}>
        {why}
      </p>
    </div>
  );
}

export function GoalProgressCard({
  userId,
  period = "month",
  title = "My goals",
  progress,
}: {
  userId: string | null;
  period?: GoalPeriod;
  title?: string;
  /** Pass an existing reader to avoid a second fetch on the same page. */
  progress?: GoalProgress;
}) {
  const app = useAppContext();
  const own = useGoalProgress(progress ? null : userId, period);
  const p = progress ?? own;
  const isMine = !!userId && userId === app.userId;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(p.why ?? ""), [p.why]);

  const saveWhy = async () => {
    const target = p.goals[0];
    if (!target) return;
    setSaving(true);
    try {
      await setGoalWhy(target.parent_goal_id ?? target.id, draft);
      setEditing(false);
      p.reload();
    } catch (e) {
      toastDbError(e, { action: "save your why" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <Target className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <div className="text-right">
          <FitText className="font-mono text-[15px] font-semibold tabular-nums">
            {p.attainment == null ? "—" : pct(p.attainment)}
          </FitText>
          <div className="text-[10px] text-muted-foreground">
            {p.win.label} · {Math.round(p.elapsed * 100)}% elapsed
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {p.loading ? (
          <div className="py-3 text-sm text-muted-foreground">Loading…</div>
        ) : p.goals.length === 0 ? (
          <div className="py-3 text-[13px] text-muted-foreground">
            No {period} target is set for {p.win.label}. That is not a score of zero — ask your
            manager to set one.
          </div>
        ) : (
          <>
            <WhyBlock
              why={p.why}
              behind={p.behind}
              canEdit={isMine && !app.writesDisabled}
              onEdit={() => setEditing(true)}
            />
            {editing && (
              <div className="space-y-1.5">
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  className="text-[13px]"
                  placeholder="e.g. Down payment on the house by next spring."
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveWhy} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            <div className="space-y-2">
              {p.lines.map((l) => (
                <div key={l.metric} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-medium">{l.label}</span>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {GOAL_METRICS[l.metric].format(l.actual)} /{" "}
                      {GOAL_METRICS[l.metric].format(l.target)}
                      <span className="ml-2 text-foreground">{pct(l.ratio)}</span>
                    </span>
                  </div>
                  <Bar ratio={l.ratio} />
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
