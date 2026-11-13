import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Clock3, FileSignature, Pencil } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CommitInput } from "@/components/commit-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  jobRatesLabel,
  loadJobRates,
  saveAgreements,
  setJobRateLine,
  setJobRateSource,
} from "@/lib/agreements";
import { toastDbError } from "@/lib/db-errors";
import { isTmJob } from "@/lib/field-forms-visibility";
import { roundMoney } from "@/lib/money";
import { jobTmAgreementLabel, loadJobTmAgreement, setJobTmAgreement } from "@/lib/tm-agreements";

/** Who sets a job's rates: the office and managers, never sales (can_set_job_rates). */
const RATE_SETTERS = ["owner", "admin", "dev", "regional", "location_manager", "office"];

const jobRatesKey = (jobId: string) => ["job-rates", jobId] as const;

/**
 * Billing & Costs prompt 4: which rates a regular job is priced at —
 * "Rates: [client agreement] ▾ | Standard | Custom" — system-defaulted from the
 * client (primary agreement preselected). Custom = this job's own lines over
 * the chosen source. A T&M job bills at T&M rates — its client's T&M agreement
 * when it has one (BC-TM-AGR-1) — and the office can switch that here.
 * `compact` is the read-only tag a document shows.
 */
export function JobRateSource({
  job,
  compact = false,
}: {
  job: { id: string; account_id: string | null; job_type?: string | null };
  compact?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  // A document that does not know its job's type asks once.
  const typeQ = useQuery({
    queryKey: ["job-rates", job.id, "type"],
    enabled: job.job_type === undefined,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("job_type")
        .eq("id", job.id)
        .maybeSingle();
      return (data as { job_type: string | null } | null)?.job_type ?? null;
    },
  });
  const tm = isTmJob(job.job_type === undefined ? typeQ.data : job.job_type);
  const canSet = (app.realRoles ?? []).some((r) => RATE_SETTERS.includes(r));
  const canStanding = (app.realRoles ?? []).some((r) => r === "owner" || r === "admin");
  const [customOpen, setCustomOpen] = useState(false);
  const q = useQuery({
    queryKey: jobRatesKey(job.id),
    enabled: !tm,
    queryFn: () => loadJobRates(job),
  });
  const tmQ = useQuery({
    queryKey: ["job-rates", job.id, "tm-touched"],
    enabled: tm,
    queryFn: async () => {
      const { data } = await supabase
        .from("job_tm_settings" as never)
        .select("job_id")
        .eq("job_id", job.id)
        .maybeSingle();
      return !!data;
    },
  });

  if (tm) {
    return (
      <TmJobRateSource
        job={job}
        editable={!compact && canSet && !app.writesDisabled}
        overrides={!!tmQ.data}
      />
    );
  }
  const r = q.data;
  if (!r?.available) return null;
  const label = jobRatesLabel(r);
  if (compact || !canSet) {
    return (
      <Badge
        variant="outline"
        className="gap-1 normal-case tracking-normal"
        data-rate-source={r.source ?? "default"}
      >
        <FileSignature className="h-3 w-3" aria-hidden /> Rates: {label}
      </Badge>
    );
  }
  const value =
    r.source === "standard"
      ? "standard"
      : r.source === "custom"
        ? "custom"
        : (r.agreementId ?? r.options[0]?.id ?? "standard");

  async function choose(v: string) {
    try {
      if (v === "custom") {
        await setJobRateSource(job.id, "custom", null);
        setCustomOpen(true);
      } else if (v === "standard") {
        await setJobRateSource(job.id, "standard", null);
      } else {
        await setJobRateSource(job.id, "agreement", v);
      }
      await qc.invalidateQueries({ queryKey: jobRatesKey(job.id) });
      await qc.invalidateQueries({ queryKey: ["document-pricing"] });
    } catch (err) {
      toastDbError(err, { action: "Setting the job's rates" });
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-2 text-sm"
      data-rate-source={r.source ?? "default"}
    >
      <span className="text-muted-foreground">Rates:</span>
      <Select value={value} onValueChange={(v) => void choose(v)} disabled={app.writesDisabled}>
        <SelectTrigger className="h-11 w-auto min-w-48 md:h-8" aria-label="Rates for this job">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {r.options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
              {o.primary ? " (primary)" : ""}
            </SelectItem>
          ))}
          <SelectItem value="standard">Standard</SelectItem>
          <SelectItem value="custom">Custom for this job</SelectItem>
        </SelectContent>
      </Select>
      {r.source === "custom" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-11 md:h-8"
          onClick={() => setCustomOpen(true)}
        >
          <Pencil aria-hidden /> Edit this job&rsquo;s rates
        </Button>
      )}
      {customOpen && (
        <CustomRatesDialog
          jobId={job.id}
          sheet={r.sheet}
          canStanding={canStanding}
          onClose={() => setCustomOpen(false)}
          onChanged={() => void qc.invalidateQueries({ queryKey: jobRatesKey(job.id) })}
        />
      )}
    </div>
  );
}

/**
 * A T&M job's rates: its client's T&M agreement, or T&M Rates. Switching
 * reprices the job's sheet (job_tm_agreement_set); rates typed for the job stay.
 */
function TmJobRateSource({
  job,
  editable,
  overrides,
}: {
  job: { id: string; account_id: string | null };
  editable: boolean;
  overrides: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...jobRatesKey(job.id), "tm-agreement"],
    queryFn: () => loadJobTmAgreement(job),
  });
  const r = q.data;
  const tag = (
    <Badge variant="outline" className="gap-1 normal-case tracking-normal" data-rate-source="tm">
      <Clock3 className="h-3 w-3" aria-hidden />
      {r?.agreementId ? `T&M: ${jobTmAgreementLabel(r)}` : "T&M rates"}
      {overrides ? " · job overrides applied" : ""}
    </Badge>
  );
  // Nothing to choose: the tag alone.
  if (!r?.available || !editable || (!r.options.length && !r.agreementId)) return tag;
  const options = [...r.options];
  if (r.agreementId && !options.some((o) => o.id === r.agreementId)) {
    options.push({
      id: r.agreementId,
      name: r.agreementName ?? "Client agreement",
      primary: false,
    });
  }

  async function choose(v: string) {
    try {
      await setJobTmAgreement(job.id, v === "tm" ? null : v);
      toast.success("T&M rates updated", {
        description: "The job's sheet is repriced; rates typed for this job are kept.",
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: jobRatesKey(job.id) }),
        qc.invalidateQueries({ queryKey: ["tm-bill-source", job.id] }),
        qc.invalidateQueries({ queryKey: ["tm-job-cost", job.id] }),
      ]);
    } catch (err) {
      toastDbError(err, { action: "Setting the job's T&M rates" });
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-rate-source="tm">
      <span className="text-muted-foreground">T&amp;M rates:</span>
      <Select value={r.agreementId ?? "tm"} onValueChange={(v) => void choose(v)}>
        <SelectTrigger className="h-11 w-auto min-w-48 md:h-8" aria-label="T&M rates for this job">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name} (client agreement{o.primary ? ", primary" : ""})
            </SelectItem>
          ))}
          <SelectItem value="tm">T&amp;M Rates</SelectItem>
        </SelectContent>
      </Select>
      {overrides && <span className="text-xs text-muted-foreground">job overrides applied</span>}
    </div>
  );
}

function CustomRatesDialog({
  jobId,
  sheet,
  canStanding,
  onClose,
  onChanged,
}: {
  jobId: string;
  sheet: { catalogItemId: string; code: string; name: string; price: number; source: string }[];
  canStanding: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const custom = sheet.filter((s) => s.source === "custom").length;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Custom rates for this job</DialogTitle>
          <DialogDescription data-custom-nudge>
            This job only (default) · make it a standing agreement (owner)
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-md border">
          {sheet.map((s) => (
            <div
              key={s.catalogItemId}
              className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2 px-3 py-1.5 text-sm"
            >
              <span className="min-w-0 truncate">
                <span className="font-mono text-xs text-muted-foreground">{s.code}</span> {s.name}
                {s.source === "custom" && (
                  <Badge variant="outline" className="ml-1 normal-case tracking-normal">
                    custom
                  </Badge>
                )}
              </span>
              <CommitInput
                value={s.price.toFixed(2)}
                inputMode="decimal"
                aria-label={`This job's price for ${s.code}`}
                className="h-11 tabular-nums md:h-8"
                onCommit={async (next) => {
                  const v = Number(next.replace(/[$,\s]/g, ""));
                  if (!Number.isFinite(v) || v < 0) {
                    toast.error("Dollars and cents, 0 or more.");
                    return false;
                  }
                  try {
                    await setJobRateLine(jobId, s.catalogItemId, roundMoney(v));
                    onChanged();
                    return true;
                  } catch (err) {
                    toastDbError(err, { action: "Saving this job's rate" });
                    return false;
                  }
                }}
              />
            </div>
          ))}
          {sheet.length === 0 && (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              This job has no rate sheet yet.
            </p>
          )}
        </div>
        {canStanding && custom > 0 && (
          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <p className="text-sm font-medium">Make it a standing agreement</p>
            <p className="text-xs text-muted-foreground">
              The {custom} custom line{custom === 1 ? "" : "s"} become an agreement for this client;
              everything else follows Standard.
            </p>
            <div className="flex flex-wrap gap-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Agreement name"
                className="h-11 min-w-0 flex-1 md:h-8"
              />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why? Required"
                className="h-11 min-w-0 flex-1 md:h-8"
              />
              <Button
                variant="cta"
                className="h-11 md:h-8"
                disabled={busy || !name.trim() || !note.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await saveAgreements(
                      [{ op: "from_job", job_id: jobId, name: name.trim() }],
                      note,
                    );
                    toast.success(`${name.trim()} is now a standing agreement`);
                    onClose();
                  } catch (err) {
                    toastDbError(err, { action: "Making the agreement" });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Make standing
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
