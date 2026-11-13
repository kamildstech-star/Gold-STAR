import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAppContext } from "@/components/app-context";
import { LabourCostCoverage } from "@/components/labour-cost-coverage";
import { supabase } from "@/integrations/supabase/client";
import { loadJobLabourRollup } from "@/lib/job-labour-rollup";
import { toastDbError } from "@/lib/db-errors";
import {
  addReferralCost,
  canViewFinance,
  componentLabel,
  deleteCostLine,
  deleteReferralCost,
  jobCostBreakdown,
  listCostLines,
  listReferralCosts,
  listWorkComponents,
  money,
  totalsOf,
  upsertCostLine,
  type WorkComponent,
} from "@/lib/finance";

/**
 * Cost breakdown for one job, split by work component. Owner / admin /
 * sales head only — the database RPC refuses everyone else, and the money
 * rule keeps figures off a rep's own job entirely.
 */
export function JobCostBreakdown({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const allowed = canViewFinance(app.roles);
  const qc = useQueryClient();

  const componentsQ = useQuery({
    queryKey: ["work-components"],
    queryFn: listWorkComponents,
    enabled: allowed,
  });
  const rowsQ = useQuery({
    queryKey: ["job-cost-breakdown", jobId],
    queryFn: () => jobCostBreakdown(jobId),
    enabled: allowed,
  });
  const linesQ = useQuery({
    queryKey: ["job-cost-lines", jobId],
    queryFn: () => listCostLines(jobId),
    enabled: allowed,
  });
  const refQ = useQuery({
    queryKey: ["job-referral-costs", jobId],
    queryFn: () => listReferralCosts(jobId),
    enabled: allowed,
  });
  /*
   * Same query key, same rollup as Running cost and Labor & profitability.
   * This card prices labour from time_entries by work component, which cannot
   * see a field form's crew size - so it says so, in the same words the other
   * cards use, rather than quietly reporting a smaller number than they do.
   */
  const rollupQ = useQuery({
    queryKey: ["job-labour-rollup", jobId],
    queryFn: () => loadJobLabourRollup(supabase, jobId),
    enabled: allowed,
  });

  const components = componentsQ.data ?? [];
  const rows = rowsQ.data ?? [];
  const totals = useMemo(() => totalsOf(rows), [rows]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["job-cost-breakdown", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-cost-lines", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-referral-costs", jobId] });
  };

  const removeLine = useMutation({
    mutationFn: (id: string) => deleteCostLine(id),
    onSuccess: () => {
      toast.success("Line removed");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "remove this cost line" }),
  });

  const removeReferral = useMutation({
    mutationFn: (id: string) => deleteReferralCost(id),
    onSuccess: () => {
      toast.success("Referral cost removed");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "remove this referral cost" }),
  });

  if (!allowed) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Cost by work component</CardTitle>
          {/*
            David, 16 Sep: it was not clear what this card was showing or where
            its figures came from. It answers three questions now — what a
            "component" is, which numbers are counted, and which are not — in
            that order, because the third is what made the card confusing: it is
            deliberately narrower than Running cost above it.
          */}
          <p className="text-xs text-muted-foreground">
            Where this job&rsquo;s money has gone, split by the kind of work it was spent on &mdash;
            extraction, drying, cleaning and so on. Each row adds up the cost lines filed against
            that component: labor worked out from time entries at the rate in force on the day,
            equipment, materials, subcontractors, and anything entered by hand with the
            <span className="font-medium"> Cost line</span> button. A day filed on a field work
            ticket appears here as its own <span className="font-medium">Field work</span> line,
            priced from the hours, crew size and machines written on that ticket.
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            It counts cost lines only. The job&rsquo;s whole revenue, total cost and margin are in
            Running cost above, which also picks up equipment still accruing on site and invoices
            raised against the job &mdash; so the two cards are not meant to add to the same number.
          </p>
        </div>
        <div className="flex gap-2">
          <ReferralCostSheet jobId={jobId} onSaved={refresh} />
          <CostLineSheet jobId={jobId} components={components} onSaved={refresh} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <LabourCostCoverage rollup={rollupQ.data?.rollup} className="text-xs text-warning" />

        <div className="grid grid-cols-3 gap-2">
          <Metric label="Labor" value={money(totals.labour)} />
          <Metric label="Referral cost" value={money(totals.referral)} />
          <Metric label="Cost lines total" value={money(totals.cost)} />
        </div>

        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full min-w-[860px] text-xs">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="py-1.5 pr-2 font-medium">Component</th>
                <th className="py-1.5 pr-2 text-right font-medium">Revenue</th>
                <th className="py-1.5 pr-2 text-right font-medium">Direct</th>
                <th className="py-1.5 pr-2 text-right font-medium">Materials</th>
                <th className="py-1.5 pr-2 text-right font-medium">Subs</th>
                <th className="py-1.5 pr-2 text-right font-medium">Labor</th>
                <th className="py-1.5 pr-2 text-right font-medium">Equip days</th>
                <th className="py-1.5 pr-2 text-right font-medium">Equip cost</th>
                <th className="py-1.5 pr-2 text-right font-medium">Referral</th>
                <th className="py-1.5 pr-2 text-right font-medium">Margin</th>
                <th className="py-1.5" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-4 text-center text-muted-foreground">
                    No cost lines yet. Add Mitigation, Reconstruction or Dry Cleaning to start.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const line = (linesQ.data ?? []).find((l) => l.work_component === r.work_component);
                return (
                  <tr key={r.work_component} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">
                      {componentLabel(r.work_component, components)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.revenue)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{money(r.direct_cost)}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.materials_cost)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.subcontractor_cost)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.labour_cost)}
                      <span className="ml-1 text-muted-foreground">
                        {(r.labour_minutes / 60).toFixed(1)}h
                      </span>
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.equipment_days}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.equipment_cost)}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">
                      {money(r.referral_cost)}
                    </td>
                    <td
                      className={`py-1.5 pr-2 text-right tabular-nums ${r.margin < 0 ? "text-destructive" : ""}`}
                    >
                      {money(r.margin)}
                      {r.margin_pct != null && (
                        <span className="ml-1 text-muted-foreground">{r.margin_pct}%</span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      {line && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={app.writesDisabled}
                          onClick={() => removeLine.mutate(line.id)}
                        >
                          Remove
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(refQ.data ?? []).length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium">Referral cost lines</p>
            {(refQ.data ?? []).map((r) => (
              <div
                key={r.id}
                className="flex items-center gap-2 border-b py-1 text-xs last:border-0"
              >
                <span className="font-medium">
                  {r.accounts?.name ?? r.source_name ?? "Referral source"}
                </span>
                {r.work_component && (
                  <Badge variant="secondary" className="text-[10px]">
                    {componentLabel(r.work_component, components)}
                  </Badge>
                )}
                <span className="text-muted-foreground">{r.paid_on ?? "unpaid"}</span>
                <span className="ml-auto tabular-nums">{money(r.amount)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  disabled={app.writesDisabled}
                  onClick={() => removeReferral.mutate(r.id)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-[4px] border bg-muted/30 px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={`text-sm font-semibold tabular-nums ${tone === "bad" ? "text-destructive" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function CostLineSheet({
  jobId,
  components,
  onSaved,
}: {
  jobId: string;
  components: WorkComponent[];
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [component, setComponent] = useState(components[0]?.key ?? "mitigation");
  const [revenue, setRevenue] = useState("");
  const [direct, setDirect] = useState("");
  const [materials, setMaterials] = useState("");
  const [subs, setSubs] = useState("");
  const [equipCost, setEquipCost] = useState("");
  const [equipDays, setEquipDays] = useState("");

  const save = useMutation({
    mutationFn: () =>
      upsertCostLine({
        job_id: jobId,
        work_component: component,
        revenue: Number(revenue) || 0,
        direct_cost: Number(direct) || 0,
        materials_cost: Number(materials) || 0,
        subcontractor_cost: Number(subs) || 0,
        equipment_cost: Number(equipCost) || 0,
        equipment_days: Number(equipDays) || 0,
      }),
    onSuccess: () => {
      toast.success("Cost line saved");
      setOpen(false);
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "save this cost line" }),
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">Cost line</Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-sm">Revenue and cost by component</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 pt-3">
          <div>
            <Label className="text-xs">Work component</Label>
            <Select value={component} onValueChange={setComponent}>
              <SelectTrigger className="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {components.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Revenue" value={revenue} onChange={setRevenue} />
            <Field label="Direct cost" value={direct} onChange={setDirect} />
            <Field label="Materials" value={materials} onChange={setMaterials} />
            <Field label="Subcontractors" value={subs} onChange={setSubs} />
            <Field label="Equipment cost" value={equipCost} onChange={setEquipCost} />
            <Field label="Equipment days" value={equipDays} onChange={setEquipDays} decimals={0} />
          </div>
          <p className="text-xs text-muted-foreground">
            Labor is not entered here — it comes from time entries and the effective-dated labor
            rate.
          </p>
          <Button
            className="w-full"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Save line
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ReferralCostSheet({ jobId, onSaved }: { jobId: string; onSaved: () => void }) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState("");
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: () =>
      addReferralCost({
        job_id: jobId,
        work_component: null,
        account_id: null,
        source_name: source.trim() || null,
        amount: Number(amount) || 0,
        basis: "flat",
        rate_percent: null,
        paid_on: paidOn || null,
        note: note.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Referral cost added");
      setOpen(false);
      setAmount("");
      setSource("");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "record this referral cost" }),
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          Referral cost
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-sm">Referral cost</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 pt-3">
          <div>
            <Label className="text-xs">Source</Label>
            <Input value={source} onChange={(e) => setSource(e.target.value)} className="h-10" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Amount" value={amount} onChange={setAmount} />
            <div>
              <Label className="text-xs">Paid on</Label>
              <Input
                type="date"
                className="h-10"
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Note</Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="h-10" />
          </div>
          <Button
            className="w-full"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Every figure on this card is dollars except the equipment-day count, and
 * the dollar figures are the ones that run to five and six digits, so the box
 * groups the digits as they are typed. The value handed back is still the
 * clean digit string the save path runs through `Number()`.
 */
function Field({
  label,
  value,
  onChange,
  decimals = 2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  decimals?: number;
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <NumberInput
        className="h-10"
        decimals={decimals}
        value={value}
        onValueChange={(_, clean) => onChange(clean)}
      />
    </div>
  );
}
