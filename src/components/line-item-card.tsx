import { ArrowDown, ArrowUp, Percent, Trash2 } from "lucide-react";

import { CalcInput, PlainNumberInput } from "@/components/calc-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UOMS, fmtMoney, fmtQuantity, lineTax, lineTotal, num } from "@/lib/estimates";

/**
 * The shape both `estimate_lines` and `invoice_lines` share. Typed structurally
 * on purpose: the estimate and the invoice line editor must never drift, and a
 * card that only knows these columns cannot be specialised to one of them.
 */
export interface LineItemCardLine {
  id: string;
  name: string;
  description: string | null;
  code: string | null;
  uom: string;
  quantity: number;
  /** `null` when the viewer may not see cost; the card then has no Cost field. */
  unit_cost: number | null;
  unit_price: number;
  taxable: boolean;
  subtotal: number;
  // Only here because lineTax/lineTotal read them; the card never draws either.
  note: string | null;
  is_discount: boolean;
}

/** The subset of a line patch this card can produce. */
export interface LineItemCardPatch {
  name?: string;
  description?: string | null;
  uom?: string;
  quantity?: number;
  unit_cost?: number;
  unit_price?: number;
  taxable?: boolean;
}

/** 44px: the smallest thing a gloved thumb hits reliably. */
const FIELD = "h-11 text-base";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * One line of work, stacked for a phone.
 *
 * The desktop table is nine columns wide and holds an input in nearly every
 * cell; at 390px that is eight screens of sideways scrolling to price a single
 * line. Below the breakpoint the row becomes this card instead — name and
 * description across the top, the four numbers in a 2x2 grid, tax and total
 * along the bottom.
 *
 * Reordering is explicit up/down buttons rather than the table's drag grip. A
 * 6px handle is not a thumb target, and a vertical drag on a phone is the same
 * gesture as scrolling the page — the two cannot both win.
 */
export function LineItemCard({
  line,
  rate,
  disabled,
  index,
  count,
  onPatch,
  onMove,
  onDiscount,
  onRemove,
}: {
  line: LineItemCardLine;
  rate: number;
  disabled: boolean;
  index: number;
  count: number;
  onPatch: (patch: LineItemCardPatch) => void;
  onMove: (to: number) => void;
  /**
   * Take a discount off this one line. The desktop table hides the same action
   * behind a row hover, which on a touch screen is no affordance at all — so
   * here it is a plain button.
   */
  onDiscount?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-2.5 border-b p-3 last:border-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Input
            defaultValue={line.name}
            placeholder="Item"
            disabled={disabled}
            className={`${FIELD} font-medium`}
            onBlur={(e) => e.target.value !== line.name && onPatch({ name: e.target.value })}
          />
          <Textarea
            rows={2}
            defaultValue={line.description ?? ""}
            placeholder="Description"
            disabled={disabled}
            className="min-h-[3.5rem] resize-y text-base text-muted-foreground"
            onBlur={(e) => onPatch({ description: e.target.value || null })}
          />
          {line.code && (
            <span className="block font-mono text-[11px] text-muted-foreground">{line.code}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Delete line"
          disabled={disabled}
          className="size-11 shrink-0 text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="size-5" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {/* Qty takes a sum, like Cost and Unit price below it. On a phone this
            matters more, not less: the numeric keyboard has no * or /, so the
            keypad this opens is the only way to enter one at all. */}
        <Field label="Qty">
          <CalcInput
            value={num(line.quantity)}
            disabled={disabled}
            title="Type a number or a sum, e.g. 12.5 * 3 + 4"
            format={fmtQuantity}
            className={`${FIELD} text-right`}
            onCommit={(v) => onPatch({ quantity: v })}
          />
        </Field>
        <Field label="Unit">
          <Select value={line.uom} disabled={disabled} onValueChange={(v) => onPatch({ uom: v })}>
            <SelectTrigger className={FIELD}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([line.uom, ...UOMS])].map((u) => (
                <SelectItem key={u} value={u}>
                  {u}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* No cost for this viewer (job.view_costs): no Cost field at all. */}
        {line.unit_cost != null && (
          <Field label="Cost">
            <CalcInput
              value={num(line.unit_cost)}
              disabled={disabled}
              title="Type a number or a sum, e.g. 1250 / 3"
              className={`${FIELD} text-right`}
              onCommit={(v) => onPatch({ unit_cost: v })}
            />
          </Field>
        )}
        {/* A rate is copied off a sheet, not computed in the box — David:
            "unit price needs no calculator". Qty above still takes a sum. */}
        <Field label="Unit price">
          <PlainNumberInput
            value={num(line.unit_price)}
            disabled={disabled}
            title="The rate itself — a plain number"
            className={`${FIELD} text-right`}
            onCommit={(v) => onPatch({ unit_price: v })}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-2">
        {/* The switch itself is 20px tall; the label around it is what makes
            the target thumb-sized. */}
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm">
          <Switch
            checked={line.taxable}
            disabled={disabled}
            onCheckedChange={(v) => onPatch({ taxable: v })}
          />
          <span>Tax</span>
          <span className="tabular-nums text-muted-foreground">
            {fmtMoney(lineTax(line, rate))}
          </span>
        </label>
        <div className="text-right">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Total</div>
          <div className="text-base font-semibold tabular-nums">
            {fmtMoney(lineTotal(line, rate))}
          </div>
        </div>
      </div>

      {onDiscount && (
        <Button
          variant="outline"
          size="sm"
          className="h-11 w-full"
          disabled={disabled}
          onClick={onDiscount}
        >
          <Percent className="size-4" /> Discount this line
        </Button>
      )}

      {count > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-label="Move line up"
            disabled={disabled || index === 0}
            className="h-11 flex-1"
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp className="size-4" /> Up
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Move line down"
            disabled={disabled || index === count - 1}
            className="h-11 flex-1"
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown className="size-4" /> Down
          </Button>
          <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">
            {index + 1}/{count}
          </span>
        </div>
      )}
    </div>
  );
}
