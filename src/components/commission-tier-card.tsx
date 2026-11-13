import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/components/app-context";
import { toastDbError } from "@/lib/db-errors";
import {
  componentLabel,
  deleteCommissionTier,
  listCommissionTiers,
  listWorkComponents,
  saveCommissionTier,
  type WorkComponent,
  type CommissionTier,
} from "@/lib/finance";

/**
 * Bronze / Silver / Gold / Platinum are configuration, not constants: the
 * percentages, the thresholds and the work component each applies to are all
 * editable, and every row is effective-dated so past commission never moves.
 */
export function CommissionTierCard() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const componentsQ = useQuery({ queryKey: ["work-components"], queryFn: listWorkComponents });
  const tiersQ = useQuery({ queryKey: ["commission-tiers"], queryFn: listCommissionTiers });
  const components = componentsQ.data ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => deleteCommissionTier(id),
    onSuccess: () => {
      toast.success("Tier retired");
      void qc.invalidateQueries({ queryKey: ["commission-tiers"] });
    },
    onError: (e) => toastDbError(e, { action: "retire this tier" }),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm">Commission tiers</CardTitle>
          <p className="text-xs text-muted-foreground">
            Applied per work component. A rep's plan points at a tier; changing a percentage here
            only affects periods on or after its effective date.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Add tier"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {adding && (
          <TierRow
            components={components}
            onDone={() => {
              setAdding(false);
              void qc.invalidateQueries({ queryKey: ["commission-tiers"] });
            }}
          />
        )}
        {(tiersQ.data ?? []).length === 0 && !adding && (
          <p className="py-3 text-center text-xs text-muted-foreground">No tiers configured.</p>
        )}
        {(tiersQ.data ?? []).map((t) => (
          <TierRow
            key={t.id}
            tier={t}
            components={components}
            onDone={() => void qc.invalidateQueries({ queryKey: ["commission-tiers"] })}
            onRemove={() => remove.mutate(t.id)}
            disabled={app.writesDisabled}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function TierRow({
  tier,
  components,
  onDone,
  onRemove,
  disabled,
}: {
  tier?: CommissionTier;
  components: WorkComponent[];
  onDone: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const [label, setLabel] = useState(tier?.label ?? "");
  const [key, setKey] = useState(tier?.key ?? "");
  const [rate, setRate] = useState(String(tier?.rate_percent ?? ""));
  const [minAmount, setMinAmount] = useState(String(tier?.min_amount ?? "0"));
  const [component, setComponent] = useState(tier?.work_component ?? "all");
  const [from, setFrom] = useState(tier?.effective_from ?? new Date().toISOString().slice(0, 10));
  const [active, setActive] = useState(tier?.active ?? true);

  const save = useMutation({
    mutationFn: () =>
      saveCommissionTier({
        id: tier?.id,
        key: key.trim() || label.trim().toLowerCase().replace(/\s+/g, "_"),
        label: label.trim(),
        rate_percent: Number(rate) || 0,
        min_amount: Number(minAmount) || 0,
        work_component: component === "all" ? null : component,
        effective_from: from,
        active,
      }),
    onSuccess: () => {
      toast.success("Tier saved");
      onDone();
    },
    onError: (e) => toastDbError(e, { action: "save this tier" }),
  });

  return (
    <div className="grid grid-cols-2 items-end gap-2 border-b pb-2 last:border-0 md:grid-cols-7">
      <div>
        <Label className="text-xs">Tier</Label>
        <Input className="h-9" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div>
        <Label className="text-xs">Key</Label>
        <Input
          className="h-9"
          value={key}
          placeholder="gold"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <Label className="text-xs">Rate %</Label>
        <Input
          className="h-9"
          inputMode="decimal"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
        />
      </div>
      <div>
        <Label className="text-xs">From amount</Label>
        <NumberInput
          className="h-9"
          decimals={2}
          value={minAmount}
          onValueChange={(_, clean) => setMinAmount(clean)}
        />
      </div>
      <div>
        <Label className="text-xs">Component</Label>
        <Select value={component} onValueChange={setComponent}>
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All work</SelectItem>
            {components.map((c) => (
              <SelectItem key={c.key} value={c.key}>
                {componentLabel(c.key, components)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Effective from</Label>
        <Input className="h-9" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={active} onCheckedChange={setActive} />
        <Button
          size="sm"
          className="h-9"
          disabled={save.isPending || disabled}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        {onRemove && (
          <Button size="sm" variant="ghost" className="h-9" disabled={disabled} onClick={onRemove}>
            Retire
          </Button>
        )}
      </div>
    </div>
  );
}
