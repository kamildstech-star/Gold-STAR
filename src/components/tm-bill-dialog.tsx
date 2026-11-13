/**
 * "T&M bill" on a T&M job's Billing: David's weekly T&M invoice package from
 * the daily forms (src/lib/tm-bill.ts). Pick the dates — the week of the
 * latest filled sign-in sheet by default — see the summary, then either make
 * the draft invoice (one line per category, opened in the review pop-up,
 * nothing sent) or download the detail workbook, or both.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, FileSpreadsheet, FileText, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { supabase } from "@/integrations/supabase/client";
import { useRefreshTmDerivedOnSync } from "@/lib/tm-derived";
import { useExportGate } from "@/lib/export-guard";
import { downloadXlsx } from "@/lib/export-table";
import {
  TM_BILL_CATEGORIES,
  cleanCategoryChoice,
  cleanRange,
  defaultBillRange,
  rangeLabel,
  selectCategories,
  tmBillWorkbook,
  withCategoryAmounts,
  type BillRange,
  type CategoryAmounts,
  type TmBill,
  type TmBillCategory,
} from "@/lib/tm-bill";
import {
  billFromSource,
  loadTmBillSource,
  type TmBillJob,
  type TmBillLayout,
} from "@/lib/tm-bill-run";
import { setJobTmRate } from "@/lib/tm-job-rates";
import { TmBillRulesEditor } from "@/components/tm-bill-rules-editor";
import { resolveRules } from "@/lib/tm-bill-rules";
import { saveJobTmRules } from "@/lib/tm-bill-rules-store";
import { useCan } from "@/lib/permissions";
import { toastDbError } from "@/lib/db-errors";

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TmBillDialog({
  open,
  onOpenChange,
  job,
  creating,
  onCreateDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: TmBillJob & { job_number: string | null; customer_name: string | null };
  creating: boolean;
  onCreateDraft: (bill: TmBill, layout: TmBillLayout) => void;
}) {
  const [layout, setLayout] = useState<TmBillLayout>("itemized");
  const today = localToday();
  const exportGate = useExportGate();
  const qc = useQueryClient();
  /*
   * TM2: a code billed at $0 is fixed for THIS job in one click — the job's
   * own rate sheet, not Settings, so no other job is re-priced. Who may see
   * the job's costs bills it (the job_tm_rates write policy).
   */
  const canSetRates = useCan("job.view_costs");
  const setRate = async (code: string, raw: string) => {
    try {
      await setJobTmRate(supabase as never, job.id, code, raw);
      toast.success(`${code} rate set for this job`);
      void qc.invalidateQueries({ queryKey: ["tm-bill-source", job.id] });
    } catch (e) {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: `Set the ${code} rate for this job` });
    }
  };
  useRefreshTmDerivedOnSync(job.id);
  const sourceQ = useQuery({
    queryKey: ["tm-bill-source", job.id, today],
    enabled: open,
    queryFn: () => loadTmBillSource(supabase as never, job, today),
  });

  const [range, setRange] = useState<BillRange | null>(null);
  const [includeUnsigned, setIncludeUnsigned] = useState(false);
  // The default week, once the forms are read; kept if the user changed it.
  useEffect(() => {
    if (!open) {
      setRange(null);
      return;
    }
    if (sourceQ.data && !range) {
      setRange(
        defaultBillRange(
          sourceQ.data.signIns.filter((s) => s.payload.rows.length > 0).map((s) => s.date),
          today,
        ),
      );
    }
  }, [open, sourceQ.data, range, today]);

  /*
   * Which categories this job's bill carries (26 Oct): every customer's bill
   * is different — three lines on one, two on another, all on some. Kept per
   * job on this device, so next week's bill opens with the same choice.
   */
  const choiceKey = `tm-bill-categories:${job.id}`;
  const [picked, setPicked] = useState<TmBillCategory[]>(() => {
    try {
      return cleanCategoryChoice(JSON.parse(localStorage.getItem(choiceKey) ?? "null"));
    } catch {
      return [...TM_BILL_CATEGORIES];
    }
  });
  const togglePick = (k: TmBillCategory, on: boolean) => {
    const next = TM_BILL_CATEGORIES.filter((c) => (c === k ? on : picked.includes(c)));
    if (next.length === 0) return; // a bill needs at least one line
    setPicked(next);
    try {
      localStorage.setItem(choiceKey, JSON.stringify(next));
    } catch {
      // Storage blocked: the choice still holds for this bill.
    }
  };

  const knownCodes = useMemo(
    () => new Set((sourceQ.data?.codes ?? []).map((c) => c.code.toUpperCase())),
    [sourceQ.data],
  );

  /* Amounts typed over the computed ones, for this bill only (4 Nov). */
  const [typed, setTyped] = useState<CategoryAmounts>({});
  useEffect(() => {
    if (!open) setTyped({});
  }, [open]);
  const computedBill = useMemo(
    () =>
      sourceQ.data && range ? billFromSource(sourceQ.data, range, includeUnsigned, today) : null,
    [sourceQ.data, range, includeUnsigned, today],
  );
  const fullBill = useMemo(
    () => (computedBill ? withCategoryAmounts(computedBill, typed) : null),
    [computedBill, typed],
  );
  const bill = useMemo(
    () => (fullBill ? selectCategories(fullBill, picked) : null),
    [fullBill, picked],
  );

  const download = () => {
    if (!bill) return;
    void exportGate.runExport({
      surface: "tm-bill",
      entity: job.job_number ?? job.id,
      recordCount: bill.labor.length + bill.materials.length + bill.equipment.length,
      format: "xlsx",
      filters: { job_id: job.id, from: bill.range.from, to: bill.range.to },
      download: () =>
        downloadXlsx(
          `tm-bill-${job.job_number ?? "job"}-${bill.range.from}`,
          tmBillWorkbook(bill, { jobNumber: job.job_number, customer: job.customer_name }),
        ),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] max-w-2xl overflow-y-auto" data-tm-bill-dialog>
        <DialogHeader>
          <DialogTitle>T&amp;M bill</DialogTitle>
          <DialogDescription>
            The week&rsquo;s bill from the daily T&amp;M forms: signed sign-in hours at each title
            code&rsquo;s rate, the 3% small-tools fee, per diem, the supply lists and the equipment
            on site. Make a draft invoice to review, or download the detail workbook.
          </DialogDescription>
        </DialogHeader>

        {sourceQ.isError ? (
          <p className="text-sm text-destructive">
            The job&rsquo;s forms could not be read — nothing was billed.
          </p>
        ) : !bill || !range ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading the daily forms…
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label className="text-xs" htmlFor="tm-bill-from">
                  From
                </Label>
                <Input
                  id="tm-bill-from"
                  type="date"
                  className="w-[160px]"
                  value={range.from}
                  onChange={(e) => setRange(cleanRange(e.target.value, range.to, today))}
                />
              </div>
              <div>
                <Label className="text-xs" htmlFor="tm-bill-to">
                  To
                </Label>
                <Input
                  id="tm-bill-to"
                  type="date"
                  className="w-[160px]"
                  value={range.to}
                  onChange={(e) => setRange(cleanRange(range.from, e.target.value, today))}
                />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <Checkbox
                  checked={includeUnsigned}
                  onCheckedChange={(v) => setIncludeUnsigned(v === true)}
                  aria-label="Include unsigned hours"
                />
                Include unsigned hours
              </label>
            </div>

            <table className="w-full text-sm" data-tm-bill-summary>
              <tbody className="divide-y">
                {fullBill!.categories.map((c) => {
                  const on = picked.includes(c.key);
                  return (
                    <tr
                      key={c.key}
                      data-tm-bill-category={c.key}
                      className={on ? "" : "opacity-60"}
                    >
                      <td className="w-8 py-1.5 align-top">
                        <Checkbox
                          className="mt-0.5"
                          checked={on}
                          disabled={on && picked.length === 1}
                          onCheckedChange={(v) => togglePick(c.key, v === true)}
                          aria-label={`Include ${c.label} on this bill`}
                        />
                      </td>
                      <td className="py-1.5 pr-2">
                        <div className="font-medium">{c.label}</div>
                        <div className="text-xs text-muted-foreground">
                          {on ? c.detail : "Not on this bill."}
                        </div>
                      </td>
                      <td className="w-36 py-1.5 text-right align-top">
                        {/* Type over any amount — the "enter by hand" lines
                            included; Reset puts the worked-out figure back.
                            The amount is in the key: the box is uncontrolled,
                            so without it a figure worked out again (new dates,
                            a sheet just uploaded, a rate just set) left the
                            old one showing — and leaving the box then saved
                            that old figure as "entered by hand". */}
                        <NumberInput
                          key={`${c.key}:${typed[c.key] ?? "auto"}:${c.amount}`}
                          className={`h-8 w-32 text-right font-mono tabular-nums ${on ? "" : "line-through"}`}
                          decimals={2}
                          allowMath
                          defaultValue={c.amount}
                          disabled={!on}
                          aria-label={`${c.label} amount`}
                          onCommit={(next) => {
                            const computed =
                              computedBill?.categories.find((x) => x.key === c.key)?.amount ?? 0;
                            setTyped((prev) => {
                              const out = { ...prev };
                              if (next == null || next === computed) delete out[c.key];
                              else out[c.key] = next;
                              return out;
                            });
                          }}
                        />
                        {typed[c.key] != null ? (
                          <button
                            type="button"
                            className="mt-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                            onClick={() =>
                              setTyped((prev) => {
                                const out = { ...prev };
                                delete out[c.key];
                                return out;
                              })
                            }
                          >
                            Changed by hand · Reset
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td />
                  <td className="py-2 font-semibold">
                    Sub Total · {rangeLabel(bill.range)}
                    {picked.length < TM_BILL_CATEGORIES.length ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        · {picked.length} of {TM_BILL_CATEGORIES.length} categories
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 text-right font-mono font-semibold tabular-nums">
                    {money(bill.subtotal)}
                  </td>
                </tr>
                {/* The sample's totals block, beneath the Sub Total (TM4). */}
                {(
                  [
                    ["Off-Site Logistics / Support OH Fee", bill.totals.ohFee],
                    ["Other / Additional Fees", bill.totals.otherFees],
                    [
                      bill.taxPercent > 0
                        ? `Tax Total (${bill.taxPercent}% on taxable lines)`
                        : "Tax Total",
                      bill.totals.tax,
                    ],
                    ["Previous Payments / Credits", bill.totals.previousPayments],
                  ] as const
                ).map(([label, amount]) => (
                  <tr key={label} data-tm-bill-total-line className="text-muted-foreground">
                    <td />
                    <td className="py-1">{label}</td>
                    <td className="py-1 text-right font-mono tabular-nums">{money(amount)}</td>
                  </tr>
                ))}
                <tr data-tm-bill-total-due>
                  <td />
                  <td className="py-2 font-semibold">Invoice Total Amount Due</td>
                  <td className="py-2 text-right font-mono font-semibold tabular-nums">
                    {money(bill.totals.totalDue)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground">
              Untick a category to leave it off this customer&rsquo;s bill — the choice is kept for
              this job. A category at $0 is left off the customer&rsquo;s invoice by itself. The
              draft takes the job&rsquo;s tax rate and marks the taxable lines; other fees and
              previous payments are entered on the invoice. Every line is editable there; nothing is
              sent.
            </p>

            {(bill.unsignedExcluded.length > 0 ||
              bill.unpricedCodes.length > 0 ||
              !sourceQ.data?.ratesAvailable) && (
              <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
                {!sourceQ.data?.ratesAvailable && (
                  <p className="flex gap-1.5">
                    <AlertTriangle className="size-3.5 shrink-0" /> T&amp;M rates are not set up on
                    this database yet — every line is at $0 until they are.
                  </p>
                )}
                {bill.unsignedExcluded.length > 0 && (
                  <p className="flex gap-1.5">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {bill.unsignedExcluded.length} unsigned person-day
                    {bill.unsignedExcluded.length === 1 ? "" : "s"} left out (
                    {bill.unsignedExcluded
                      .slice(0, 4)
                      .map((u) => `${u.name} ${u.date.slice(5)}`)
                      .join(", ")}
                    {bill.unsignedExcluded.length > 4 ? "…" : ""}) — tick &ldquo;Include unsigned
                    hours&rdquo; to bill them, marked as not signed.
                  </p>
                )}
                {bill.unpricedCodes.length > 0 && (
                  <div className="space-y-1.5" data-tm-unpriced>
                    <p className="flex gap-1.5">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      No rate set for {bill.unpricedCodes.join(", ")} — billed at $0.
                      {canSetRates && sourceQ.data?.jobRatesAvailable
                        ? " Set the rate for this job:"
                        : " Set rates under Settings › Operations › T&M rate codes."}
                    </p>
                    {canSetRates && sourceQ.data?.jobRatesAvailable && (
                      <div className="flex flex-wrap gap-2">
                        {bill.unpricedCodes
                          .filter((c) => knownCodes.has(c))
                          .map((c) => (
                            <JobRateSetter key={c} code={c} onSet={(raw) => setRate(c, raw)} />
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {canSetRates && sourceQ.data?.rules.jobOverrideAvailable && (
              <details className="rounded-md border p-3" data-tm-job-rules>
                <summary className="cursor-pointer text-sm font-medium">
                  Rules for this job
                  {Object.keys(sourceQ.data.rules.job).length > 0
                    ? " · overridden"
                    : " · from Settings"}
                </summary>
                <div className="pt-3">
                  <TmBillRulesEditor
                    value={sourceQ.data.rules.job}
                    inherited={resolveRules(sourceQ.data.rules.settings, {})}
                    laborCodes={sourceQ.data.codes.filter((c) => c.section === "labor")}
                    onSave={async (next) => {
                      try {
                        await saveJobTmRules(supabase as never, job.id, next);
                        toast.success("Rules saved for this job");
                        void qc.invalidateQueries({ queryKey: ["tm-bill-source", job.id] });
                      } catch (e) {
                        toastDbError(e, { action: "Saving this job's T&M rules" });
                      }
                    }}
                  />
                </div>
              </details>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {exportGate.allowed && (
                <Button variant="outline" onClick={download}>
                  <FileSpreadsheet className="mr-1.5 size-4" /> Download workbook
                </Button>
              )}
              <label className="mr-auto flex items-center gap-2 text-sm text-muted-foreground">
                Invoice shows
                <select
                  value={layout}
                  onChange={(e) => setLayout(e.target.value as TmBillLayout)}
                  className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground"
                  aria-label="Invoice layout"
                >
                  <option value="itemized">Day by day (itemized)</option>
                  <option value="summary">Category totals only</option>
                </select>
              </label>
              <Button onClick={() => onCreateDraft(bill, layout)} disabled={creating}>
                {creating ? (
                  <Loader2 className="mr-1.5 size-4 animate-spin" />
                ) : (
                  <FileText className="mr-1.5 size-4" />
                )}
                Create draft invoice
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One code's rate, typed and set for this job (TM2). */
function JobRateSetter({ code, onSet }: { code: string; onSet: (raw: string) => Promise<void> }) {
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex items-center gap-1"
      data-tm-job-rate={code}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!raw.trim()) return;
        setBusy(true);
        try {
          await onSet(raw);
        } finally {
          setBusy(false);
        }
      }}
    >
      <span className="font-mono">{code}</span>
      <Input
        className="h-7 w-24 bg-background text-xs"
        inputMode="decimal"
        placeholder="Rate $"
        aria-label={`Rate for ${code} on this job`}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={busy || !raw.trim()}
      >
        Set for this job
      </Button>
    </form>
  );
}
