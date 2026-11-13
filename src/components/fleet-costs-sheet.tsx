import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sheet as SheetIcon } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import { fmtMoney } from "@/lib/jobs";
import { cn } from "@/lib/utils";
import {
  OWNERSHIP_LABEL,
  PERIOD_LABEL,
  fetchFleetCosts,
  financePerYear,
  perYear,
  sameCosts,
  saveFleetCosts,
  type CostPeriod,
  type Ownership,
  type VehicleCosts,
} from "@/lib/vehicle-costs";

/**
 * Fleet › Costs sheet — every vehicle's insurance and finance or lease in one
 * editable grid (5 Nov review: "a view like a spreadsheet", for entering a
 * whole insurance bill at once instead of opening 32 vehicle pages).
 *
 * The same fields as the vehicle page's Costs card (vehicle_costs). Edits
 * stay in the sheet until Save, which sends every changed vehicle in one
 * request, so the overhead engine re-sums once (fleet_overhead_sync).
 * The database decides who may change which vehicle; a refusal is shown.
 */
export function FleetCostsButton({
  vehicles,
}: {
  vehicles: readonly { id: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="h-11 gap-1.5 sm:h-7"
        onClick={() => setOpen(true)}
        disabled={vehicles.length === 0}
        data-fleet-costs-open
      >
        <SheetIcon className="size-3.5" />
        Costs sheet
      </Button>
      {open && <FleetCostsSheet vehicles={vehicles} onClose={() => setOpen(false)} />}
    </>
  );
}

function FleetCostsSheet({
  vehicles,
  onClose,
}: {
  vehicles: readonly { id: string; label: string }[];
  onClose: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const ids = useMemo(() => vehicles.map((v) => v.id), [vehicles]);
  const q = useQuery({
    queryKey: ["fleet-costs", ids.join(",")],
    queryFn: () => fetchFleetCosts(ids),
  });
  const [draft, setDraft] = useState<Map<string, VehicleCosts>>(new Map());
  useEffect(() => {
    if (q.data) setDraft(new Map(q.data));
  }, [q.data]);

  const changed = useMemo(
    () =>
      q.data
        ? [...draft.values()].filter((d) => {
            const saved = q.data!.get(d.vehicle_id);
            return saved ? !sameCosts(saved, d) : false;
          })
        : [],
    [draft, q.data],
  );
  const set = (id: string, patch: Partial<VehicleCosts>) =>
    setDraft((m) => {
      const next = new Map(m);
      const cur = next.get(id);
      if (cur) next.set(id, { ...cur, ...patch });
      return next;
    });

  const save = useMutation({
    mutationFn: () => saveFleetCosts(changed),
    onSuccess: () => {
      toast.success(
        `${changed.length} vehicle${changed.length === 1 ? "" : "s"} saved — the overhead engine is updated`,
      );
      void qc.invalidateQueries({ queryKey: ["fleet-costs"] });
      void qc.invalidateQueries({ queryKey: ["vehicle-costs"] });
      void qc.invalidateQueries({ queryKey: ["overhead"] });
    },
    onError: (e) => toastDbError(e, { action: "Save vehicle costs" }),
  });

  const readOnly = app.writesDisabled;
  const rows = vehicles.map((v) => ({ v, c: draft.get(v.id) })).filter((r) => r.c);
  const totals = rows.reduce(
    (t, { c }) => ({
      insurance: t.insurance + perYear(c!.insurance_amount, c!.insurance_period),
      finance: t.finance + financePerYear(c!),
    }),
    { insurance: 0, finance: 0 },
  );
  const dirty = changed.length > 0;

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) return;
        if (dirty && !window.confirm("Close without saving the changes?")) return;
        onClose();
      }}
    >
      <DialogContent className="flex max-h-[100svh] w-full max-w-6xl flex-col gap-3 overflow-hidden p-3 sm:p-5">
        <DialogHeader>
          <DialogTitle>Vehicle costs</DialogTitle>
          <DialogDescription>
            Insurance and finance or lease for every vehicle. Tab moves along a row; nothing is
            saved until you press Save. The totals feed the overhead engine.
          </DialogDescription>
        </DialogHeader>

        {q.isPending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : q.isError ? (
          <p className="text-sm text-destructive">
            Vehicle costs could not be loaded — that is not the same as there being none.
          </p>
        ) : q.data === null ? (
          <p className="text-sm text-muted-foreground">
            Vehicle costs need a database update that has not been applied yet.
          </p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto rounded-lg border" data-fleet-costs-sheet>
            {/* Desktop and tablet: one row per vehicle, a cell per field. */}
            <table className="hidden w-full border-collapse text-sm md:table">
              <thead className="sticky top-0 z-10 bg-muted text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Vehicle</th>
                  <th className="px-2 py-2">Insurance</th>
                  <th className="px-2 py-2">Paid</th>
                  <th className="px-2 py-2">Ownership</th>
                  <th className="px-2 py-2">Finance / lease</th>
                  <th className="px-2 py-2">Paid</th>
                  <th className="px-3 py-2 text-right">A year</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map(({ v, c }) => {
                  const saved = q.data!.get(v.id)!;
                  const edited = !sameCosts(saved, c!);
                  const owned = c!.ownership === "owned";
                  return (
                    <tr
                      key={v.id}
                      className={cn(edited && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]")}
                      data-vehicle-row={v.id}
                    >
                      <td className="max-w-[14rem] truncate px-3 py-1.5 font-medium">{v.label}</td>
                      <td className="px-2 py-1.5">
                        <MoneyCell
                          value={c!.insurance_amount}
                          label={`${v.label} insurance`}
                          disabled={readOnly}
                          onChange={(n) => set(v.id, { insurance_amount: n })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <PeriodCell
                          value={c!.insurance_period}
                          label={`${v.label} insurance period`}
                          disabled={readOnly}
                          onChange={(p) => set(v.id, { insurance_period: p })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <OwnershipCell
                          value={c!.ownership}
                          label={`${v.label} ownership`}
                          disabled={readOnly}
                          onChange={(o) => set(v.id, { ownership: o })}
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        {owned ? (
                          <span className="px-2 text-xs text-muted-foreground">—</span>
                        ) : (
                          <MoneyCell
                            value={c!.finance_amount}
                            label={`${v.label} finance or lease payment`}
                            disabled={readOnly}
                            onChange={(n) => set(v.id, { finance_amount: n })}
                          />
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        {owned ? null : (
                          <PeriodCell
                            value={c!.finance_period}
                            label={`${v.label} payment period`}
                            disabled={readOnly}
                            onChange={(p) => set(v.id, { finance_period: p })}
                          />
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono tabular-nums">
                        {fmtMoney(
                          perYear(c!.insurance_amount, c!.insurance_period) + financePerYear(c!),
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Phone: the same fields as a compact card per vehicle. */}
            <ul className="divide-y md:hidden">
              {rows.map(({ v, c }) => {
                const saved = q.data!.get(v.id)!;
                const edited = !sameCosts(saved, c!);
                const owned = c!.ownership === "owned";
                return (
                  <li
                    key={v.id}
                    className={cn(
                      "space-y-2 p-3",
                      edited && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{v.label}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {fmtMoney(
                          perYear(c!.insurance_amount, c!.insurance_period) + financePerYear(c!),
                        )}{" "}
                        / yr
                      </span>
                    </div>
                    <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                      <MoneyCell
                        value={c!.insurance_amount}
                        label={`${v.label} insurance`}
                        placeholder="Insurance"
                        disabled={readOnly}
                        onChange={(n) => set(v.id, { insurance_amount: n })}
                      />
                      <PeriodCell
                        value={c!.insurance_period}
                        label={`${v.label} insurance period`}
                        disabled={readOnly}
                        onChange={(p) => set(v.id, { insurance_period: p })}
                      />
                      <div className="col-span-2">
                        <OwnershipCell
                          value={c!.ownership}
                          label={`${v.label} ownership`}
                          disabled={readOnly}
                          onChange={(o) => set(v.id, { ownership: o })}
                        />
                      </div>
                      {!owned && (
                        <>
                          <MoneyCell
                            value={c!.finance_amount}
                            label={`${v.label} finance or lease payment`}
                            placeholder={c!.ownership === "leased" ? "Lease" : "Finance"}
                            disabled={readOnly}
                            onChange={(n) => set(v.id, { finance_amount: n })}
                          />
                          <PeriodCell
                            value={c!.finance_period}
                            label={`${v.label} payment period`}
                            disabled={readOnly}
                            onChange={(p) => set(v.id, { finance_period: p })}
                          />
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground" data-fleet-costs-totals>
            Insurance {fmtMoney(totals.insurance)} / yr · Finance and leases{" "}
            {fmtMoney(totals.finance)} / yr
          </p>
          <div className="flex gap-2">
            {dirty && (
              <Button
                variant="ghost"
                className="h-11 sm:h-9"
                onClick={() => q.data && setDraft(new Map(q.data))}
              >
                Undo changes
              </Button>
            )}
            <Button
              className="h-11 sm:h-9"
              disabled={readOnly || !dirty || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? "Saving…"
                : dirty
                  ? `Save ${changed.length} vehicle${changed.length === 1 ? "" : "s"}`
                  : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MoneyCell({
  value,
  label,
  placeholder = "0.00",
  disabled,
  onChange,
}: {
  value: number | null;
  label: string;
  placeholder?: string;
  disabled: boolean;
  onChange: (v: number | null) => void;
}) {
  return (
    <NumberInput
      className="h-10 w-full min-w-[7rem] text-right font-mono tabular-nums md:h-8"
      decimals={2}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={label}
      onValueChange={(v) => onChange(v)}
    />
  );
}

function PeriodCell({
  value,
  label,
  disabled,
  onChange,
}: {
  value: CostPeriod;
  label: string;
  disabled: boolean;
  onChange: (p: CostPeriod) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as CostPeriod)} disabled={disabled}>
      <SelectTrigger className="h-10 w-full min-w-[6.5rem] md:h-8" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(PERIOD_LABEL) as CostPeriod[]).map((k) => (
          <SelectItem key={k} value={k}>
            {PERIOD_LABEL[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function OwnershipCell({
  value,
  label,
  disabled,
  onChange,
}: {
  value: Ownership;
  label: string;
  disabled: boolean;
  onChange: (o: Ownership) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Ownership)} disabled={disabled}>
      <SelectTrigger className="h-10 w-full min-w-[7rem] md:h-8" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(OWNERSHIP_LABEL) as Ownership[]).map((k) => (
          <SelectItem key={k} value={k}>
            {OWNERSHIP_LABEL[k]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
