import { useState } from "react";
import { AlertCircle, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePaymentTypes, isUndeterminedJobType } from "@/lib/loss-categories";
import { toastDbError } from "@/lib/db-errors";
import { cn } from "@/lib/utils";

/**
 * Intake frequently does not know who is paying. The job is workable as
 * "Undetermined", but it must not reach an invoice that way — so the chip
 * nags quietly on the header and the prompt blocks billing.
 */
export function UndeterminedJobTypeChip({ jobType }: { jobType: string | null | undefined }) {
  if (!isUndeterminedJobType(jobType)) return null;
  return (
    <span
      title="Job type is still unresolved — set Insurance, Cash or Reconstruction before invoicing."
      className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
    >
      <HelpCircle className="size-3" />
      Type undetermined
    </span>
  );
}

export function ResolveJobTypePrompt({
  jobId,
  jobType,
  onResolved,
  className,
}: {
  jobId: string;
  jobType: string | null | undefined;
  onResolved?: (key: string) => void;
  className?: string;
}) {
  const paymentTypes = usePaymentTypes();
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);

  if (!isUndeterminedJobType(jobType)) return null;

  const save = async () => {
    if (!choice) return;
    setSaving(true);
    const { error } = await supabase.from("jobs").update({ job_type: choice }).eq("id", jobId);
    setSaving(false);
    if (error) return toastDbError(error, { action: "Setting the job type" });
    toast.success(`Job type set to ${paymentTypes.label(choice)}.`);
    onResolved?.(choice);
  };

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-sm",
        className,
      )}
    >
      <AlertCircle className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1">
        Job type is still <strong>Undetermined</strong>. Resolve it before invoicing — it decides
        who is billed.
      </span>
      <Select value={choice} onValueChange={setChoice}>
        <SelectTrigger className="h-8 w-[160px]">
          <SelectValue placeholder="Set job type" />
        </SelectTrigger>
        <SelectContent>
          {paymentTypes.options
            .filter((o) => o.key !== "undetermined")
            .map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
        </SelectContent>
      </Select>
      <Button size="sm" className="h-8" disabled={!choice || saving} onClick={save}>
        Save
      </Button>
    </div>
  );
}

export function RentersPolicyChip({ kind }: { kind: string | null | undefined }) {
  if (kind !== "renters") return null;
  return (
    <span
      title="Renter's policy — the tenant's insurer covers contents, not the structure. Confirm who is paying."
      className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent-foreground"
    >
      Renter&rsquo;s policy
    </span>
  );
}
