import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ShieldOff } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import {
  STEP_HREF,
  closeChecklist,
  listChecklists,
  listSteps,
  progress,
  toggleStep,
  type Checklist,
} from "@/lib/offboarding";
import { deactivateUserNow } from "@/lib/offboarding.functions";
import { isPrivileged } from "@/lib/roles";

/**
 * Offboarding — formerly its own page (/admin/offboarding), now the
 * Offboarding tab of a person on People. With `userId` the lockout is for
 * that person and only their checklists show.
 */
export function OffboardingPanel({ userId }: { userId?: string } = {}) {
  const app = useAppContext();
  // The lockout is `is_sales_lead` on the server (owner, admin, dev, Sales
  // Head). Anyone else on this page gets no lockout card at all.
  const canLockOut = isPrivileged(app.roles) || app.roles.includes("sales_head");
  const qc = useQueryClient();
  const [target, setTarget] = useState(userId ?? "");
  const [reason, setReason] = useState("");

  const peopleQ = useQuery({
    queryKey: ["offboarding-people"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name, is_active")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const listQ = useQuery({ queryKey: ["offboarding-checklists"], queryFn: listChecklists });
  const checklists = (listQ.data ?? []).filter((c) => !userId || c.user_id === userId);
  /** Already deactivated: the lockout has nothing left to do for this person. */
  const alreadyOut =
    !!userId && !peopleQ.isLoading && !(peopleQ.data ?? []).some((p) => p.user_id === userId);

  const deactivate = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Pick the person to revoke.");
      return deactivateUserNow({ data: { userId: target, reason: reason.trim() || null } });
    },
    onSuccess: () => {
      toast.success(
        "New sign-ins blocked, profile deactivated and integrations flagged. Existing access may remain until it expires.",
      );
      setTarget(userId ?? "");
      setReason("");
      void qc.invalidateQueries({ queryKey: ["offboarding-checklists"] });
      void qc.invalidateQueries({ queryKey: ["offboarding-people"] });
      void qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (e) => toastDbError(e, { action: "Deactivate user" }),
  });

  return (
    <div className="space-y-3">
      {canLockOut ? (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShieldOff className="size-4 text-destructive" /> One-action lockout
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Blocks new sign-ins, deactivates the profile and flags linked integrations for
              revocation. Existing access may remain until it expires. The checklist below opens
              automatically for the remaining offboarding work.
            </p>
            <div
              className={
                userId
                  ? "grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end"
                  : "grid gap-2 sm:grid-cols-[minmax(0,280px)_1fr_auto] sm:items-end"
              }
            >
              <div className={userId ? "hidden" : undefined}>
                <Label className="text-xs">Person</Label>
                <Select value={target} onValueChange={setTarget}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {(peopleQ.data ?? []).map((p) => (
                      <SelectItem key={p.user_id} value={p.user_id}>
                        {p.full_name ?? p.user_id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Reason (recorded)</Label>
                <Input value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="destructive"
                    disabled={!target || alreadyOut || app.writesDisabled || deactivate.isPending}
                  >
                    Deactivate now
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Block sign-in and start offboarding?</AlertDialogTitle>
                    <AlertDialogDescription>
                      New sign-ins will be blocked. Existing access may remain until it expires.
                      Linked integrations are flagged for revocation and an offboarding checklist
                      opens.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => deactivate.mutate()}
                      className="bg-destructive text-destructive-foreground"
                    >
                      Revoke
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        {checklists.map((c) => (
          <ChecklistCard key={c.id} checklist={c} />
        ))}
        {checklists.length === 0 && !listQ.isLoading && (
          <Card>
            <CardContent className="py-6 text-center text-xs text-muted-foreground">
              No offboarding in progress.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ChecklistCard({ checklist }: { checklist: Checklist }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const nameQ = useQuery({
    queryKey: ["profile-name", checklist.user_id],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", checklist.user_id)
        .maybeSingle();
      return data?.full_name ?? null;
    },
  });
  const stepsQ = useQuery({
    queryKey: ["offboarding-steps", checklist.id],
    queryFn: () => listSteps(checklist.id),
  });
  const steps = stepsQ.data ?? [];
  const p = progress(steps);

  const flip = useMutation({
    mutationFn: (step: (typeof steps)[number]) => toggleStep(step, app.userId!),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["offboarding-steps", checklist.id] }),
    onError: (e) => toastDbError(e, { action: "Update step" }),
  });

  const finish = useMutation({
    mutationFn: () => closeChecklist(checklist.id),
    onSuccess: () => {
      toast.success("Offboarding closed out");
      void qc.invalidateQueries({ queryKey: ["offboarding-checklists"] });
    },
    onError: (e) => toastDbError(e, { action: "Close checklist" }),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">
          {nameQ.data ?? checklist.user_id.slice(0, 8)}
          <Badge
            variant={checklist.status === "complete" ? "secondary" : "outline"}
            className="ml-2 text-[10px]"
          >
            {checklist.status}
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {p.done}/{p.total}
          </span>
          <Progress value={p.pct} className="h-1.5 w-24" />
          {checklist.status !== "complete" && p.done === p.total && p.total > 0 && (
            <Button size="sm" disabled={app.writesDisabled} onClick={() => finish.mutate()}>
              Close out
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {steps.map((s) => (
            <li key={s.id} className="flex items-center gap-2 px-3 py-2">
              <Checkbox
                checked={!!s.completed_at}
                disabled={app.writesDisabled}
                onCheckedChange={() => flip.mutate(s)}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{s.label}</div>
                {s.completed_at ? (
                  <div className="text-[10px] text-muted-foreground">
                    Completed {new Date(s.completed_at).toLocaleString("en-US")}
                  </div>
                ) : null}
              </div>
              {s.step_key === "reassign_book" ? (
                <Button asChild size="sm" variant="outline" className="h-6 text-[11px]">
                  <Link
                    to="/admin/people/$userId"
                    params={{ userId: checklist.user_id }}
                    search={{ tab: "book" }}
                  >
                    Open
                  </Link>
                </Button>
              ) : STEP_HREF[s.step_key] ? (
                <Button asChild size="sm" variant="outline" className="h-6 text-[11px]">
                  <Link to={STEP_HREF[s.step_key]!}>Open</Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
