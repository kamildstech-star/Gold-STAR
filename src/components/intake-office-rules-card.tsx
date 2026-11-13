import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WarningLine } from "@/components/ui-density";
import { toastDbError } from "@/lib/db-errors";
import {
  INTAKE_OFFICE_RULES_QUERY_KEY,
  addIntakeOfficeRule,
  fetchIntakeOfficeRules,
  intakeRuleProblem,
  rematchWaitingIntakes,
  removeIntakeOfficeRule,
} from "@/lib/intake-office-rules";
import { US_STATES } from "@/lib/intake-routing";
import { isPrivileged } from "@/lib/roles";

/** The intake inbox's query key (routes/_authenticated/intake-inbox.tsx). */
const INTAKE_INBOX_KEY = ["intake-inbox"] as const;

const STATE_NAME = new Map(US_STATES.map((s) => [s.code, s.name]));

/**
 * State and ZIP rules for which office an intake form goes to.
 *
 * Mark: "add in here a address match for intake, that will set certain states
 * to certain offices that overrides the closest match". It lives on the
 * Territory page because that is where he asked for it and where the people
 * who decide who covers what already work — but it is not part of the chase:
 * markets and zones decide which chaser is woken for a fire, these decide
 * which office a customer's form lands in. Zones are never read for this (a
 * zone belongs to a market, not to an office).
 *
 * Saving or removing a rule re-routes the forms already waiting, so the
 * Scranton lead that prompted the rule moves too. A form a person placed by
 * hand, or one that is already a job, never moves.
 */
export function IntakeOfficeRulesCard({ disabled }: { disabled: boolean }) {
  const app = useAppContext();
  const qc = useQueryClient();
  // The role decides whether the controls are drawn at all; `disabled` (View As
  // preview) only switches them off.
  const canEdit = isPrivileged(app.roles);

  const q = useQuery({ queryKey: INTAKE_OFFICE_RULES_QUERY_KEY, queryFn: fetchIntakeOfficeRules });
  const rules = q.data?.rules ?? [];

  const offices = useMemo(
    () => [...app.allLocations].sort((a, b) => a.code.localeCompare(b.code)),
    [app.allLocations],
  );
  const officeName = (id: string) => {
    const o = offices.find((l) => l.id === id);
    return o ? `${o.code} · ${o.name}` : "an office that no longer exists";
  };

  const [kind, setKind] = useState<"state" | "zip">("state");
  const [value, setValue] = useState("");
  const [locationId, setLocationId] = useState("");
  const problem = intakeRuleProblem({ kind, value, locationId }, rules, officeName);

  /* The rule is saved first and on its own: a failed re-route must not read
     as a failed save. The waiting forms are then routed again under the new
     rules, and the toast says how many moved. */
  const afterChange = async (saved: string) => {
    void qc.invalidateQueries({ queryKey: INTAKE_OFFICE_RULES_QUERY_KEY });
    try {
      const moved = await rematchWaitingIntakes();
      void qc.invalidateQueries({ queryKey: INTAKE_INBOX_KEY });
      toast.success(
        moved
          ? `${saved} · ${moved} waiting intake form${moved === 1 ? "" : "s"} re-routed`
          : saved,
      );
    } catch (e) {
      toast.success(saved);
      toastDbError(e, { action: "Re-routing the waiting intake forms" });
    }
  };

  const add = useMutation({
    mutationFn: () => addIntakeOfficeRule({ kind, value, locationId }),
    onSuccess: async () => {
      setValue("");
      await afterChange("Rule saved");
    },
    onError: (e) => toastDbError(e, { action: "Saving the intake rule" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => removeIntakeOfficeRule(id),
    onSuccess: async () => {
      await afterChange("Rule removed");
    },
    onError: (e) => toastDbError(e, { action: "Removing the intake rule" }),
  });

  const sorted = [...rules].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
  );

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Intake office rules</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Which office a form from the website button or a standing intake link goes to. Checked
            in this order:
          </p>
          <ol className="list-decimal space-y-0.5 pl-5">
            <li>
              A <span className="font-medium text-foreground">ZIP rule</span> — the longest match
              wins, so 18508 beats 185.
            </li>
            <li>
              A <span className="font-medium text-foreground">state rule</span>.
            </li>
            <li>
              Otherwise the <span className="font-medium text-foreground">closest office</span> — in
              the property's state when it has one.
            </li>
          </ol>
          <p>
            A rule beats the closest office every time. An office picked by hand on the intake card
            beats every rule. Saving a rule re-routes the forms still waiting; forms that are
            already jobs never move.
          </p>
        </div>

        {q.data && !q.data.available ? (
          <WarningLine>
            Intake office rules are not live yet — the database is missing the migration that adds
            them. Forms keep going to the closest office until it is applied.
          </WarningLine>
        ) : null}
        {q.isError ? <WarningLine>The intake office rules could not be loaded.</WarningLine> : null}

        {sorted.length === 0 && q.data?.available ? (
          <p className="text-sm text-muted-foreground">
            No rules. Every form goes to the closest office.
          </p>
        ) : null}

        {sorted.map((r) => (
          <div key={r.id} className="flex items-center gap-2 border-b py-1.5 text-sm last:border-0">
            <Badge variant="outline" className="text-[10px]">
              {r.kind === "state" ? "State" : "ZIP"}
            </Badge>
            <span className="font-medium">
              {r.kind === "state" ? `${r.value} · ${STATE_NAME.get(r.value) ?? r.value}` : r.value}
            </span>
            <span className="text-muted-foreground">→</span>
            <span>{officeName(r.location_id)}</span>
            {canEdit && (
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7"
                aria-label={`Remove the rule for ${r.value}`}
                disabled={disabled || remove.isPending}
                onClick={() => remove.mutate(r.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        ))}

        {q.data?.available && canEdit ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-2">
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as "state" | "zip");
                  setValue("");
                }}
              >
                <SelectTrigger className="h-8 w-32" aria-label="Rule type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="state">State</SelectItem>
                  <SelectItem value="zip">ZIP prefix</SelectItem>
                </SelectContent>
              </Select>
              {kind === "state" ? (
                <Select value={value} onValueChange={setValue}>
                  <SelectTrigger className="h-8 w-48" aria-label="State">
                    <SelectValue placeholder="State" />
                  </SelectTrigger>
                  <SelectContent>
                    {US_STATES.map((s) => (
                      <SelectItem key={s.code} value={s.code}>
                        {s.code} · {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  inputMode="numeric"
                  placeholder="e.g. 185"
                  aria-label="ZIP prefix"
                  maxLength={5}
                  value={value}
                  onChange={(e) => setValue(e.target.value.replace(/\D/g, ""))}
                  className="h-8 w-28"
                />
              )}
              <span className="self-center text-xs text-muted-foreground">goes to</span>
              <Select value={locationId} onValueChange={setLocationId}>
                <SelectTrigger className="h-8 w-56" aria-label="Office">
                  <SelectValue placeholder="Office" />
                </SelectTrigger>
                <SelectContent>
                  {offices.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.code} · {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={disabled || Boolean(problem) || add.isPending}
                onClick={() => add.mutate()}
              >
                <Plus className="mr-1 size-4" /> Add
              </Button>
            </div>
            {/* Only a clash is worth saying before the click; "choose a state"
                is what the empty pickers already say. */}
            {problem && problem.includes("already goes to") ? (
              <p className="text-xs text-warning">{problem}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
