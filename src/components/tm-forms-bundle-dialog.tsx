/**
 * "Download all" on the Field Form tab: every T&M sheet on the job, filled
 * and signed, as one PDF for the carrier — the whole job or a date range,
 * grouped by kind. David, 15 Oct. The work is src/lib/tm-forms-bundle.ts;
 * this is the picker in front of it.
 */
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { downloadPdf } from "@/lib/pdf-actions";
import {
  TM_FORM_KINDS,
  getTmForm,
  jobNameFor,
  type JobFacts,
  type TmFormKind,
  type TmFormSummary,
} from "@/lib/tm-forms";
import type { TmRateCode } from "@/lib/tm-rate-codes";
import { cn } from "@/lib/utils";

/*
 * The pure half is imported statically (it is plain arithmetic); the PDF half
 * is loaded on press, so the tab does not carry the merger until it is used.
 */
import {
  TM_BUNDLE_GROUP_TITLE,
  WHOLE_JOB,
  groupTmForms,
  tmBundleFilename,
  tmJobSpan,
  type TmBundleRange,
} from "@/lib/tm-forms-bundle-plan";

export function TmFormsBundleDialog({
  open,
  onOpenChange,
  jobId,
  jobNumber,
  facts,
  rows,
  catalogue,
  template,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  jobNumber: string | null;
  facts: JobFacts;
  rows: readonly TmFormSummary[];
  catalogue: readonly TmRateCode[];
  template: (kind: TmFormKind) => Promise<Uint8Array>;
}) {
  const span = useMemo(() => tmJobSpan(rows), [rows]);
  const [whole, setWhole] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kinds, setKinds] = useState<TmFormKind[]>([...TM_FORM_KINDS]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Each opening starts from the whole job, with the range boxes primed to it.
  useEffect(() => {
    if (!open) return;
    setWhole(true);
    setFrom(span?.first ?? "");
    setTo(span?.last ?? "");
    setKinds([...TM_FORM_KINDS]);
    setProgress(null);
  }, [open, span?.first, span?.last]);

  const range: TmBundleRange = useMemo(
    () => (whole ? WHOLE_JOB : { from: from || null, to: to || null }),
    [whole, from, to],
  );
  const groups = useMemo(() => groupTmForms(rows, range, kinds), [rows, range, kinds]);
  const count = groups.reduce((n, g) => n + g.days.length, 0);

  async function download() {
    if (!count) return;
    setBusy(true);
    setProgress({ done: 0, total: count });
    try {
      const { buildTmFormsBundle } = await import("@/lib/tm-forms-bundle");
      const result = await buildTmFormsBundle({
        jobName: jobNameFor(facts),
        jobNumber,
        range,
        groups,
        load: async (kind, day) => (await getTmForm(jobId, kind, day))?.payload ?? null,
        template,
        catalogue,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      downloadPdf(result.bytes, tmBundleFilename(jobNumber, range));
      if (result.skipped.length) {
        toast.warning(
          `${result.skipped.length} sheet${result.skipped.length === 1 ? "" : "s"} could not go in`,
          { description: "They are named on the PDF's last page." },
        );
      } else {
        toast.success(`${result.sheets} sheets in one PDF`, {
          description: `${result.pages} pages, grouped by sheet type.`,
        });
      }
      onOpenChange(false);
    } catch (e) {
      toast.error("Could not make the PDF", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md">
        <DialogHeader>
          <DialogTitle>Download all field forms</DialogTitle>
          <DialogDescription>
            Every filled sheet with its signatures, as one PDF to send to the carrier. Grouped by
            sheet type, oldest day first.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Which days">
            {[
              { v: true, label: "Whole job" },
              { v: false, label: "Date range" },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={whole === o.v}
                onClick={() => setWhole(o.v)}
                className={cn(
                  "min-h-11 rounded-[8px] border px-3 text-left font-medium",
                  whole === o.v && "border-primary bg-primary/5",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>

          {!whole && (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="block text-xs font-semibold">From</span>
                <Input
                  type="date"
                  className="h-11"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="space-y-1">
                <span className="block text-xs font-semibold">To</span>
                <Input
                  type="date"
                  className="h-11"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </div>
          )}

          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-semibold">Include</legend>
            {TM_FORM_KINDS.map((kind) => {
              const n = groups.find((g) => g.kind === kind)?.days.length ?? 0;
              return (
                <label key={kind} className="flex min-h-9 items-center gap-2">
                  <Checkbox
                    checked={kinds.includes(kind)}
                    onCheckedChange={(v) =>
                      setKinds((cur) =>
                        v
                          ? TM_FORM_KINDS.filter((k) => k === kind || cur.includes(k))
                          : cur.filter((k) => k !== kind),
                      )
                    }
                  />
                  <span className="flex-1">{TM_BUNDLE_GROUP_TITLE[kind]}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {kinds.includes(kind) ? n : "—"}
                  </span>
                </label>
              );
            })}
          </fieldset>

          {count === 0 && (
            <p className="text-xs text-muted-foreground">
              {rows.length === 0
                ? "No sheets have been saved on this job yet."
                : "No saved sheets in that range."}
            </p>
          )}
          {progress && (
            <p className="text-xs text-muted-foreground" aria-live="polite">
              Filling sheet {progress.done} of {progress.total}…
            </p>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={busy || count === 0} onClick={() => void download()}>
            {busy ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 size-4" />
            )}
            {count ? `Download ${count} sheet${count === 1 ? "" : "s"}` : "Download"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
