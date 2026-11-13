import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CommitInput } from "@/components/commit-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { LoadError } from "@/components/ui-density";
import { ReferralCommissionRulesAdmin } from "@/components/referral-commission-rules-admin";
import { toastDbError } from "@/lib/db-errors";
import {
  commissionEntryProblem,
  commissionKey,
  loadCommissionSources,
  saveCommissionSources,
} from "@/lib/commission-entries";
import { isActiveSource, kindOf, type CommissionSource } from "@/lib/job-ledger";

/**
 * Settings → Commissions: the named rates a job's commission is picked from.
 *
 * David, 24 Sep: "in the backend we built different commission rates and
 * different names — Mark Adelman gets 20%, Nissen Goldstein gets 15%. I just
 * have a dropdown, I select his name and his rate automatically deducts."
 *
 * The list is the `commission_rates` setting the job ledger has always read,
 * so the seeded rates are already here. Nothing is ever deleted — a job points
 * at its entry — so "remove" is a switch: off means it is no longer offered
 * for new jobs, and every job that used it keeps its rate.
 */
export function CommissionAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["commission-rates"], queryFn: loadCommissionSources });
  const sources = q.data ?? [];
  const [draft, setDraft] = useState<{
    label: string;
    pct: number | null;
    kind: "person" | "role";
  }>({
    label: "",
    pct: null,
    kind: "person",
  });

  const save = useMutation({
    mutationFn: (next: CommissionSource[]) => saveCommissionSources(next, app.userId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["commission-rates"] }),
    onError: (e) => toastDbError(e, { action: "save the commission rates" }),
  });

  const patch = async (key: string, change: Partial<CommissionSource>): Promise<boolean> => {
    const current = sources.find((s) => s.key === key)!;
    const next = { ...current, ...change };
    const problem = commissionEntryProblem({ label: next.label, pct: next.pct }, sources, key);
    if (problem) {
      toast.error(problem);
      return false;
    }
    try {
      await save.mutateAsync(sources.map((s) => (s.key === key ? next : s)));
      return true;
    } catch {
      return false;
    }
  };

  const add = () => {
    const problem = commissionEntryProblem(draft, sources);
    if (problem) return toast.error(problem);
    const entry: CommissionSource = {
      key: commissionKey(
        draft.label,
        sources.map((s) => s.key),
      ),
      label: draft.label.trim(),
      pct: draft.pct!,
      kind: draft.kind,
    };
    save.mutate([...sources, entry], {
      onSuccess: () => {
        toast.success(`${entry.label} added`);
        setDraft({ label: "", pct: null, kind: draft.kind });
      },
    });
  };

  const group = (kind: "person" | "role") => sources.filter((s) => kindOf(s) === kind);

  return (
    <div className="space-y-3">
      {/* Mark, 7 Oct: "(in admin we need to be able put the rates for each
          referral), or use the current commission page in admin settings".
          The most specific deal first; the rates below are its fallback. */}
      <ReferralCommissionRulesAdmin />
      {q.isError ? <LoadError what="the commission rates" error={q.error} /> : null}
      {(["person", "role"] as const).map((kind) => (
        <Card key={kind}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{kind === "person" ? "People" : "Roles"}</CardTitle>
            <p className="text-xs text-muted-foreground">
              {kind === "person"
                ? 'A named person\'s own rate — pick them as "Came from" on a job and it applies when the referrer has no deal above.'
                : "The default rate for a kind of source, when there is no named person."}{" "}
              Percent of the job's revenue, the same base as the referrer deals.
            </p>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {group(kind).length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">None yet.</p>
            ) : (
              group(kind).map((s) => (
                <div
                  key={s.key}
                  data-commission-row
                  className="grid grid-cols-[minmax(0,1fr)_6.5rem_auto] items-center gap-2 px-3 py-2"
                >
                  <CommitInput
                    value={s.label}
                    aria-label={`Name of ${s.label}`}
                    onCommit={(next) => patch(s.key, { label: next })}
                  />
                  <div className="flex items-center gap-1">
                    <NumberInput
                      key={`${s.key}:${s.pct}`}
                      className="h-11 md:h-8"
                      decimals={2}
                      aria-label={`${s.label} rate`}
                      defaultValue={s.pct}
                      onCommit={(n) => n != null && n !== s.pct && void patch(s.key, { pct: n })}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {isActiveSource(s) ? "Active" : "Off"}
                    <Switch
                      checked={isActiveSource(s)}
                      aria-label={`${s.label} offered on jobs`}
                      onCheckedChange={(v) => void patch(s.key, { active: v })}
                    />
                  </label>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Add a name or role</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 p-3 pt-0 sm:grid-cols-[minmax(0,1fr)_7rem_9rem_auto] sm:items-end">
          <Input
            className="h-11 md:h-9"
            aria-label="Name"
            placeholder="Mark Adelman"
            value={draft.label}
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
          <NumberInput
            className="h-11 md:h-9"
            decimals={2}
            aria-label="Rate percent"
            placeholder="Rate %"
            value={draft.pct}
            onValueChange={(n) => setDraft((d) => ({ ...d, pct: n }))}
          />
          <Select
            value={draft.kind}
            onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as "person" | "role" }))}
          >
            <SelectTrigger className="h-11 md:h-9" aria-label="Person or role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="person">A person</SelectItem>
              <SelectItem value="role">A role</SelectItem>
            </SelectContent>
          </Select>
          <Button
            className="h-11 md:h-9"
            disabled={save.isPending || app.writesDisabled}
            onClick={add}
          >
            <Plus className="mr-1 size-4" /> Add
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
