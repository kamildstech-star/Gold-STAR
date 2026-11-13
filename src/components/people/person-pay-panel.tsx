import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { money } from "@/lib/expenses";
import {
  COMMISSION_BASES,
  COMMISSION_BASIS_LABEL,
  DRAW_PERIODS,
  PAY_TYPES,
  PAY_TYPE_LABEL,
  SALES_TYPES,
  SALES_TYPE_LABEL,
  effectiveRangeLabel,
  isInForce,
  listCommissionPlans,
  listPayStructures,
  listSalesTypes,
  setCommissionPlan,
  setPayStructure,
  setSalesType,
  todayIso,
  type PayType,
  type SalaryBasis,
  type SalesType,
} from "@/lib/pay";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";

const SALES_TYPE_OPTS = optionsFrom(SALES_TYPES, SALES_TYPE_LABEL);

/**
 * People and pay — formerly its own page (/admin/payroll), now the Pay &
 * commission tab of a person on People. Everything is stored with effective
 * dates rather than overwritten, so a commission calculated in March still
 * computes at March's terms after a June change.
 */
export function PersonPayPanel({ userId }: { userId: string }) {
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs text-muted-foreground">
        Everything here varies by hire and can change mid-employment, so it is stored with effective
        dates rather than overwritten. A commission calculated in March still computes at March's
        terms after a June change.
      </p>
      <SalesTypeCard userId={userId} />
      <PayCard userId={userId} />
      <CommissionCard userId={userId} />
    </div>
  );
}

function History({
  rows,
}: {
  rows: { id: string; effective_from: string; effective_to: string | null }[];
}) {
  return (
    <ul className="divide-y border-t">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
          <span className="text-muted-foreground">{effectiveRangeLabel(r)}</span>
          {isInForce(r) ? (
            <Badge variant="outline" className="text-[10px]">
              In force
            </Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SalesTypeCard({ userId }: { userId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["sales-types", userId], queryFn: () => listSalesTypes(userId) });
  const current = (q.data ?? []).find((r) => isInForce(r));
  const [salesType, setType] = useState<SalesType>("in_house");
  const [from, setFrom] = useState(todayIso());

  const save = useMutation({
    mutationFn: () => setSalesType({ userId, salesType, effectiveFrom: from, current }),
    onSuccess: () => {
      toast.success("Sales type updated");
      void qc.invalidateQueries({ queryKey: ["sales-types", userId] });
    },
    onError: (e) => toastDbError(e, { action: "Set sales type" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Sales type{" "}
          {current ? (
            <span className="ml-1 font-normal text-muted-foreground">
              — currently {SALES_TYPE_LABEL[current.sales_type]}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Drives the default dashboard and day mode.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={salesType} onValueChange={(v) => setType(v as SalesType)}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="sales_type" fallback={SALES_TYPE_OPTS} />
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Effective from</Label>
            <Input
              type="date"
              className="w-[170px]"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Apply
          </Button>
        </div>
      </CardContent>
      <History rows={q.data ?? []} />
    </Card>
  );
}

function PayCard({ userId }: { userId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["pay-structures", userId],
    queryFn: () => listPayStructures(userId),
  });
  const current = (q.data ?? []).find((r) => isInForce(r));
  const [payType, setPayType] = useState<PayType>("combination");
  const [salaryBasis, setSalaryBasis] = useState<SalaryBasis>("annual");
  const [salary, setSalary] = useState("");
  const [hourly, setHourly] = useState("");
  const [hoursWeek, setHoursWeek] = useState("40");
  const [draw, setDraw] = useState("");
  const [drawPeriod, setDrawPeriod] = useState<string>("biweekly");
  const [recoverable, setRecoverable] = useState(true);
  const [from, setFrom] = useState(todayIso());

  const save = useMutation({
    mutationFn: () =>
      setPayStructure({
        userId,
        payType,
        salaryBasis,
        hourlyRate: hourly ? Number(hourly) : null,
        hoursPerWeek: hoursWeek ? Number(hoursWeek) : null,
        baseSalaryAnnual: salary ? Number(salary) : null,
        drawAmount: draw ? Number(draw) : null,
        drawPeriod: draw ? drawPeriod : null,
        drawRecoverable: recoverable,
        effectiveFrom: from,
        current,
      }),
    onSuccess: () => {
      toast.success("Pay structure updated");
      void qc.invalidateQueries({ queryKey: ["pay-structures", userId] });
    },
    onError: (e) => toastDbError(e, { action: "Set pay structure" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          Pay structure
          {current ? (
            <span className="ml-1 font-normal text-muted-foreground">
              — {PAY_TYPE_LABEL[current.pay_type]}
              {current.salary_basis === "hourly"
                ? current.hourly_rate
                  ? ` · ${money(current.hourly_rate)}/hr × ${current.hours_per_week ?? 40}h/wk`
                  : ""
                : current.base_salary_annual
                  ? ` · ${money(current.base_salary_annual)}/yr`
                  : ""}
              {current.draw_amount
                ? ` · draw ${money(current.draw_amount)} ${current.draw_recoverable ? "(recoverable)" : "(non-recoverable)"}`
                : ""}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={payType} onValueChange={(v) => setPayType(v as PayType)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {PAY_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Salary basis</Label>
            <Select value={salaryBasis} onValueChange={(v) => setSalaryBasis(v as SalaryBasis)}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="annual">Annual</SelectItem>
                <SelectItem value="hourly">Hourly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {salaryBasis === "annual" ? (
            <div>
              <Label className="text-xs">Base salary (annual)</Label>
              <NumberInput
                className="w-[150px]"
                decimals={2}
                value={salary}
                onValueChange={(_, clean) => setSalary(clean)}
              />
            </div>
          ) : (
            <>
              <div>
                <Label className="text-xs">Hourly rate</Label>
                <NumberInput
                  className="w-[120px]"
                  decimals={2}
                  value={hourly}
                  onValueChange={(_, clean) => setHourly(clean)}
                />
              </div>
              <div>
                <Label className="text-xs">Hours / week</Label>
                <Input
                  className="w-[110px]"
                  inputMode="decimal"
                  value={hoursWeek}
                  onChange={(e) => setHoursWeek(e.target.value)}
                />
              </div>
            </>
          )}
          <div>
            <Label className="text-xs">Draw</Label>
            <NumberInput
              className="w-[120px]"
              decimals={2}
              value={draw}
              onValueChange={(_, clean) => setDraw(clean)}
            />
          </div>
          <div>
            <Label className="text-xs">Draw period</Label>
            <Select value={drawPeriod} onValueChange={setDrawPeriod}>
              <SelectTrigger className="w-[150px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DRAW_PERIODS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 pb-2">
            <Switch checked={recoverable} onCheckedChange={setRecoverable} />
            <span className="text-xs">Recoverable draw</span>
          </div>
          <div>
            <Label className="text-xs">Effective from</Label>
            <Input
              type="date"
              className="w-[170px]"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Apply
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Recoverable and non-recoverable draws behave differently over time, so the flag is stored
          with the terms rather than assumed.
        </p>
      </CardContent>
      <History rows={q.data ?? []} />
    </Card>
  );
}

function CommissionCard({ userId }: { userId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["commission-plans", userId],
    queryFn: () => listCommissionPlans(userId),
  });
  const [source, setSource] = useState("default");
  const [basis, setBasis] = useState<string>("collected");
  const [rate, setRate] = useState("");
  const [flat, setFlat] = useState("");
  const [from, setFrom] = useState(todayIso());

  const current = (q.data ?? []).filter((r) => isInForce(r));

  const save = useMutation({
    mutationFn: () =>
      setCommissionPlan({
        userId,
        dealSource: source.trim() || "default",
        basis,
        ratePercent: rate ? Number(rate) : null,
        flatAmount: flat ? Number(flat) : null,
        effectiveFrom: from,
        current: (q.data ?? []).find(
          (r) => isInForce(r) && r.deal_source === (source.trim() || "default"),
        ),
      }),
    onSuccess: () => {
      toast.success("Commission plan updated");
      void qc.invalidateQueries({ queryKey: ["commission-plans", userId] });
    },
    onError: (e) => toastDbError(e, { action: "Set commission plan" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Commission by deal source</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          Commission varies by person and by where the deal came from — a referral is not paid like
          a self-sourced account. Add one row per source; "default" covers anything unmatched.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">Deal source</Label>
            <Input
              className="w-[180px]"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="referral"
            />
          </div>
          <div>
            <Label className="text-xs">Basis</Label>
            <Select value={basis} onValueChange={setBasis}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMISSION_BASES.map((b) => (
                  <SelectItem key={b} value={b}>
                    {COMMISSION_BASIS_LABEL[b]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Rate %</Label>
            <Input
              className="w-[100px]"
              inputMode="decimal"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">or flat</Label>
            <NumberInput
              className="w-[110px]"
              decimals={2}
              value={flat}
              onValueChange={(_, clean) => setFlat(clean)}
            />
          </div>
          <div>
            <Label className="text-xs">Effective from</Label>
            <Input
              type="date"
              className="w-[170px]"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Apply
          </Button>
        </div>
        <ul className="divide-y border-t pt-1">
          {current.map((r) => (
            <li key={r.id} className="flex items-center gap-2 py-1.5 text-[11px]">
              <span className="w-[140px] font-medium">{r.deal_source}</span>
              <span className="text-muted-foreground">
                {COMMISSION_BASIS_LABEL[r.basis] ?? r.basis}
              </span>
              <span className="tabular-nums">
                {r.rate_percent ? `${r.rate_percent}%` : r.flat_amount ? money(r.flat_amount) : "—"}
              </span>
              <span className="ml-auto text-muted-foreground">{effectiveRangeLabel(r)}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
