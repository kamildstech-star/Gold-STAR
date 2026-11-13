import { useQuery } from "@tanstack/react-query";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  EMAIL_ACTION_HONESTY,
  JOB_ASSIGNEE_LABEL,
  JOB_ROLE_LABEL,
  type JobAssignmentRole,
  type RuleAction,
} from "@/lib/automation";
import { useJobStages } from "@/lib/job-stages";

/*
 * The job half of the rule editor. David, 22 Sep: "once a job is switched
 * from this status to 'sent to adjuster' or 'invoice pending payment',
 * automatically seven days later... I should get an email to follow up, or I
 * should get a task to follow up."
 *
 * The stages are the office's own job stages (Settings → Pipelines), so a
 * stage David adds there — "Sent to adjuster" — is offered here with no code
 * change.
 */

export function JobStagePicker({
  locationId,
  value,
  onChange,
}: {
  locationId: string | null;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const { stages, loading } = useJobStages(locationId);
  if (loading) return <p className="text-xs text-muted-foreground">Loading job stages…</p>;
  if (stages.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No job stages found for this office. Add them under Settings → Pipelines.
      </p>
    );
  }
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...new Set([...value, id])] : value.filter((x) => x !== id));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-medium">When a job is in</legend>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {stages.map((s) => (
          <label key={s.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
            <Checkbox
              checked={value.includes(s.id)}
              onCheckedChange={(v) => toggle(s.id, v === true)}
              aria-label={`Stage ${s.name}`}
            />
            {s.name}
          </label>
        ))}
      </div>
      {value.length === 0 ? (
        <p className="text-xs text-destructive">
          Pick at least one stage — a rule with none never fires.
        </p>
      ) : null}
    </fieldset>
  );
}

const JOB_MODES = ["office_manager", "crew_chief", "job_role", "specific"] as const;
const JOB_ROLES = Object.keys(JOB_ROLE_LABEL) as JobAssignmentRole[];

/** Who a job rule's task or email is for — always staff. */
export function JobRecipientPicker({
  action,
  onChange,
}: {
  action: RuleAction;
  onChange: (patch: Partial<RuleAction>) => void;
}) {
  const mode = (JOB_MODES as readonly string[]).includes(action.assignee_mode ?? "")
    ? (action.assignee_mode as (typeof JOB_MODES)[number])
    : "office_manager";
  const peopleQ = useQuery({
    queryKey: ["automation-people"],
    enabled: mode === "specific",
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label className="text-xs">{action.kind === "send_email" ? "Email" : "Assign to"}</Label>
        <Select
          value={mode}
          onValueChange={(v) =>
            onChange({
              assignee_mode: v as RuleAction["assignee_mode"],
              ...(v === "job_role" && !action.job_role ? { job_role: "project_manager" } : {}),
            })
          }
        >
          <SelectTrigger className="h-11 w-[200px] md:h-9" aria-label="Recipient">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {JOB_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {JOB_ASSIGNEE_LABEL[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {mode === "job_role" ? (
        <Select
          value={action.job_role ?? "project_manager"}
          onValueChange={(v) => onChange({ job_role: v as JobAssignmentRole })}
        >
          <SelectTrigger className="h-11 w-[180px] md:h-9" aria-label="Role on the job">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {JOB_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {JOB_ROLE_LABEL[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {mode === "specific" ? (
        <Select
          value={action.assignee_user_id ?? ""}
          onValueChange={(v) => onChange({ assignee_user_id: v })}
        >
          <SelectTrigger className="h-11 w-[220px] md:h-9" aria-label="Person">
            <SelectValue placeholder="Choose a person" />
          </SelectTrigger>
          <SelectContent>
            {(peopleQ.data ?? []).map((p) => (
              <SelectItem key={p.user_id} value={p.user_id}>
                {p.full_name ?? p.user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {action.kind === "send_email" ? (
        <p className="w-full text-[11px] text-muted-foreground">{EMAIL_ACTION_HONESTY}</p>
      ) : action.assignee_mode === "office_manager" || !action.assignee_mode ? (
        <p className="w-full text-[11px] text-muted-foreground">
          The office&rsquo;s first manager gets the task; an office with no manager gets it in its
          unassigned queue.
        </p>
      ) : null}
    </div>
  );
}
