import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, UserCog } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  NUDGE_KIND_LABEL,
  fetchEscalatedNudges,
  fetchMyNudges,
  reassignAccount,
  resolveNudge,
  type Nudge,
} from "@/lib/coaching";
import { isSalesLeadership, isPrivileged } from "@/lib/roles";

export const Route = createFileRoute("/_authenticated/coaching/nudges")({
  head: () => ({
    meta: [
      { title: "Nudges · Recovery Hub" },
      {
        name: "description",
        content:
          "Automatic reminders for missing outcomes, notes and next steps — escalated to the manager only when ignored.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NudgesPage,
});

function NudgesPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const canManage = isSalesLeadership(app.roles) || isPrivileged(app.roles);
  const [tab, setTab] = useState<"mine" | "team">("mine");

  const mine = useQuery({
    queryKey: ["nudges", "mine", app.userId],
    queryFn: () => fetchMyNudges(app.userId!),
    enabled: !!app.userId,
  });
  const team = useQuery({
    queryKey: ["nudges", "team"],
    queryFn: fetchEscalatedNudges,
    enabled: canManage,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["nudges"] });

  const rows = tab === "mine" ? (mine.data ?? []) : (team.data ?? []);

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-3">
      <div>
        <h1 className="display-heavy text-[22px] leading-tight">Nudges</h1>
        <p className="text-[13px] text-muted-foreground">
          Reminders go to the person who can fix them. A manager only sees an item once it has been
          ignored more than once.
        </p>
      </div>

      {canManage && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "mine" | "team")}>
          <TabsList>
            <TabsTrigger value="mine">Mine ({mine.data?.length ?? 0})</TabsTrigger>
            <TabsTrigger value="team">Escalated ({team.data?.length ?? 0})</TabsTrigger>
          </TabsList>
        </Tabs>
      )}

      {rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          {tab === "mine" ? "Nothing outstanding. Clear." : "No rep has ignored a reminder."}
        </p>
      ) : (
        rows.map((n) => <NudgeRow key={n.id} nudge={n} manager={tab === "team"} onDone={refresh} />)
      )}
    </div>
  );
}

function NudgeRow({
  nudge,
  manager,
  onDone,
}: {
  nudge: Nudge;
  manager: boolean;
  onDone: () => void;
}) {
  const isIdle = nudge.kind === "idle_account";
  const [reassigning, setReassigning] = useState(false);

  const reps = useQuery({
    queryKey: ["nudges", "reps", nudge.location_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      return (data ?? []) as { user_id: string; full_name: string | null; email: string | null }[];
    },
    enabled: reassigning,
  });

  const resolve = async () => {
    try {
      await resolveNudge(nudge.id);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not clear the nudge");
    }
  };

  const doReassign = async (repId: string) => {
    if (!nudge.entity_id) return;
    try {
      await reassignAccount(nudge.entity_id, repId);
      await resolveNudge(nudge.id);
      toast.success("Account reassigned");
      setReassigning(false);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reassign");
    }
  };

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{nudge.title}</span>
              <Badge variant="outline" className="shrink-0 text-[11px]">
                {NUDGE_KIND_LABEL[nudge.kind] ?? nudge.kind}
              </Badge>
              {nudge.nudge_count > 1 && (
                <Badge variant="secondary" className="shrink-0 text-[11px]">
                  reminded {nudge.nudge_count}×
                </Badge>
              )}
              {manager && nudge.escalated_at && (
                <AlertTriangle className="size-3.5 shrink-0 text-destructive" />
              )}
            </div>
            <p className="text-[13px] text-muted-foreground">{nudge.reason}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {nudge.href && (
            <Button asChild size="sm" variant="secondary">
              <a href={nudge.href}>Open</a>
            </Button>
          )}
          {manager && isIdle && !reassigning && (
            <Button size="sm" variant="outline" onClick={() => setReassigning(true)}>
              <UserCog className="mr-1 size-4" /> Reassign
            </Button>
          )}
          {reassigning && (
            <Select onValueChange={(v) => void doReassign(v)}>
              <SelectTrigger className="h-8 w-56 text-[13px]">
                <SelectValue placeholder="Reassign to…" />
              </SelectTrigger>
              <SelectContent>
                {(reps.data ?? []).map((r) => (
                  <SelectItem key={r.user_id} value={r.user_id}>
                    {r.full_name || r.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button size="sm" variant="ghost" onClick={() => void resolve()}>
            <Check className="mr-1 size-4" /> Done
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
