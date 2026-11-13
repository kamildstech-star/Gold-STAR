import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { fmtMoney } from "@/lib/jobs";
import {
  OWNERSHIP_LABEL,
  PERIOD_LABEL,
  PERIOD_SUFFIX,
  fetchVehicleCosts,
  financePerYear,
  perYear,
  saveVehicleCosts,
  type CostPeriod,
  type Ownership,
  type VehicleCosts,
} from "@/lib/vehicle-costs";

/**
 * Costs — what this vehicle costs to insure and to finance or lease (5 Nov
 * review, T8). Each amount is kept in the period it is paid in; the yearly
 * figure under it is what Settings › Billing & Costs adds to the overhead
 * engine (T9).
 */
export function VehicleCostsCard({ vehicleId }: { vehicleId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["vehicle-costs", vehicleId],
    queryFn: () => fetchVehicleCosts(vehicleId),
  });
  const canQ = useQuery({
    queryKey: ["vehicle-can-manage", vehicleId, app.userId],
    enabled: Boolean(app.userId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "can_manage_vehicle" as never,
        { _user_id: app.userId, _vehicle_id: vehicleId } as never,
      );
      if (error) return false;
      return Boolean(data);
    },
  });
  /* Who may change these is the vehicle's own rule. Anyone else (and anyone
     while it is still being asked) reads the figures as plain text — no
     greyed-out inputs. View As keeps the inputs, disabled, as everywhere. */
  const mayManage = canQ.data === true;
  const canManage = mayManage && !app.writesDisabled;

  const [draft, setDraft] = useState<VehicleCosts | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (c: VehicleCosts) => saveVehicleCosts(c),
    onSuccess: () => {
      toast.success("Vehicle costs saved");
      void qc.invalidateQueries({ queryKey: ["vehicle-costs", vehicleId] });
      void qc.invalidateQueries({ queryKey: ["overhead"] });
    },
    onError: (e) => toastDbError(e, { action: "Save vehicle costs" }),
  });

  if (q.isPending || !draft) {
    if (q.data === null) {
      return (
        <Card>
          <CardContent className="p-3 text-sm text-muted-foreground">
            Vehicle costs need a database update that has not been applied yet.
          </CardContent>
        </Card>
      );
    }
    return null;
  }
  if (q.isError) return null;

  const saved = q.data!;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const set = (patch: Partial<VehicleCosts>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const financed = draft.ownership !== "owned";
  const yearly = perYear(draft.insurance_amount, draft.insurance_period) + financePerYear(draft);

  return (
    <Card data-vehicle-costs>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <DollarSign className="size-4" /> Costs
        </CardTitle>
        <span className="text-xs text-muted-foreground">{fmtMoney(yearly)} / year in overhead</span>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <AmountField
            id="veh-insurance"
            label="Insurance"
            amount={draft.insurance_amount}
            period={draft.insurance_period}
            readOnly={!mayManage}
            disabled={!canManage}
            onAmount={(v) => set({ insurance_amount: v })}
            onPeriod={(p) => set({ insurance_period: p })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="veh-ownership">
              Ownership
            </Label>
            {mayManage ? (
              <Select
                value={draft.ownership}
                onValueChange={(v) => set({ ownership: v as Ownership })}
                disabled={!canManage}
              >
                <SelectTrigger id="veh-ownership" className="h-10">
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
            ) : (
              <p id="veh-ownership" className="text-sm">
                {OWNERSHIP_LABEL[draft.ownership]}
              </p>
            )}
          </div>
          {financed && (
            <AmountField
              id="veh-finance"
              label={draft.ownership === "leased" ? "Lease payment" : "Finance payment"}
              amount={draft.finance_amount}
              period={draft.finance_period}
              readOnly={!mayManage}
              disabled={!canManage}
              onAmount={(v) => set({ finance_amount: v })}
              onPeriod={(p) => set({ finance_period: p })}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <p className="text-[11px] text-muted-foreground">
            Added to the overhead engine in Settings › Billing &amp; Costs as vehicle insurance and
            vehicle finance.
          </p>
          {canManage && (
            <div className="flex gap-2">
              {dirty && (
                <Button size="sm" variant="ghost" onClick={() => setDraft(saved)}>
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate(draft)}
              >
                {save.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function AmountField({
  id,
  label,
  amount,
  period,
  readOnly,
  disabled,
  onAmount,
  onPeriod,
}: {
  id: string;
  label: string;
  amount: number | null;
  period: CostPeriod;
  /** Plain text: this person may not change vehicle costs. */
  readOnly: boolean;
  disabled: boolean;
  onAmount: (v: number | null) => void;
  onPeriod: (p: CostPeriod) => void;
}) {
  const other: CostPeriod = period === "monthly" ? "yearly" : "monthly";
  const otherValue =
    amount == null ? null : period === "monthly" ? perYear(amount, "monthly") : amount / 12;
  return (
    <div className="space-y-1.5">
      <Label className="text-xs" htmlFor={id}>
        {label}
      </Label>
      {readOnly ? (
        <p id={id} className="text-sm tabular-nums">
          {amount == null ? "—" : `${fmtMoney(amount)} ${PERIOD_SUFFIX[period]}`}
        </p>
      ) : (
        <div className="flex gap-2">
          <NumberInput
            id={id}
            className="h-10 min-w-0 flex-1 text-right font-mono tabular-nums"
            decimals={2}
            value={amount}
            placeholder="0.00"
            disabled={disabled}
            onValueChange={(v) => onAmount(v)}
            aria-label={`${label} amount`}
          />
          <Select
            value={period}
            onValueChange={(v) => onPeriod(v as CostPeriod)}
            disabled={disabled}
          >
            <SelectTrigger className="h-10 w-[7.5rem] shrink-0" aria-label={`${label} period`}>
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
        </div>
      )}
      {otherValue != null && (
        <p className="text-[11px] text-muted-foreground">
          {fmtMoney(Math.round(otherValue * 100) / 100)} {PERIOD_SUFFIX[other]}
        </p>
      )}
    </div>
  );
}
