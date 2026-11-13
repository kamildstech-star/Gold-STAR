import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  blankLine,
  formatMoney,
  lineTotal,
  parseLineDrafts,
  proposalTotals,
  type ProposalDraft,
  type ProposalLineDraft,
} from "@/lib/account-proposals";

export type TemplateOption = { id: string; label: string };

const NO_TEMPLATE = "__none";

function typedNumber(raw: string): number {
  const n = Number(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * The proposal itself: title, template, the priced lines with their totals,
 * notes and terms. Nothing here loads or saves — the dialog owns that — so the
 * screen can be drawn straight from a draft in a test.
 *
 * The totals under the lines are the same arithmetic the database's generated
 * column does (`lineTotal`), so the figure the rep reads is the figure saved.
 */
export function ProposalForm({
  draft,
  onDraft,
  templates,
  readOnly = false,
  disabled = false,
}: {
  draft: ProposalDraft;
  onDraft: (next: ProposalDraft) => void;
  templates: TemplateOption[];
  /** A sent, signed, declined or expired proposal: shown, not edited. */
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const locked = readOnly || disabled;
  const { lines, errors } = parseLineDrafts(draft.lines);
  const { subtotal, total } = proposalTotals(lines);
  const setLine = (key: string, patch: Partial<ProposalLineDraft>) =>
    onDraft({
      ...draft,
      lines: draft.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    });

  return (
    <div className="space-y-4" data-testid="proposal-form">
      <div className="grid gap-3 sm:grid-cols-[1fr_16rem]">
        <div>
          <Label htmlFor="proposal-title" className="text-xs">
            Title
          </Label>
          <Input
            id="proposal-title"
            value={draft.title}
            placeholder="e.g. Annual water mitigation agreement"
            maxLength={200}
            readOnly={readOnly}
            disabled={disabled}
            onChange={(e) => onDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div>
          <Label className="text-xs">Template</Label>
          <Select
            value={draft.templateId || NO_TEMPLATE}
            disabled={locked}
            onValueChange={(v) => onDraft({ ...draft, templateId: v === NO_TEMPLATE ? "" : v })}
          >
            <SelectTrigger aria-label="Template">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TEMPLATE}>No template — pricing only</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="text-xs">Services and pricing</Label>
        <div className="mt-1 overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-sm border">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-muted text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">Description</th>
                <th className="w-20 px-2 py-1.5 text-right font-medium">Qty</th>
                <th className="w-28 px-2 py-1.5 text-right font-medium">Unit price</th>
                <th className="w-28 px-2 py-1.5 text-right font-medium">Line total</th>
                {!readOnly && <th className="w-9" aria-label="Remove" />}
              </tr>
            </thead>
            <tbody>
              {draft.lines.map((l, i) => (
                <tr key={l.key} className="border-t">
                  <td className="px-1 py-1">
                    <Input
                      aria-label={`Line ${i + 1} description`}
                      value={l.description}
                      readOnly={readOnly}
                      disabled={disabled}
                      className="h-8"
                      onChange={(e) => setLine(l.key, { description: e.target.value })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <NumberInput
                      aria-label={`Line ${i + 1} quantity`}
                      value={l.quantity}
                      decimals={2}
                      readOnly={readOnly}
                      disabled={disabled}
                      className="h-8 text-right"
                      onValueChange={(_v, clean) => setLine(l.key, { quantity: clean })}
                    />
                  </td>
                  <td className="px-1 py-1">
                    <NumberInput
                      aria-label={`Line ${i + 1} unit price`}
                      value={l.unitPrice}
                      decimals={2}
                      readOnly={readOnly}
                      disabled={disabled}
                      className="h-8 text-right"
                      onValueChange={(_v, clean) => setLine(l.key, { unitPrice: clean })}
                    />
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums" data-line-total={i + 1}>
                    {formatMoney(lineTotal(typedNumber(l.quantity), typedNumber(l.unitPrice)))}
                  </td>
                  {!readOnly && (
                    <td className="px-1 py-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8"
                        aria-label={`Remove line ${i + 1}`}
                        disabled={disabled || draft.lines.length === 1}
                        onClick={() =>
                          onDraft({ ...draft, lines: draft.lines.filter((x) => x.key !== l.key) })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t text-sm">
              <tr>
                <td colSpan={3} className="px-2 py-1 text-right text-muted-foreground">
                  Subtotal
                </td>
                <td className="px-2 py-1 text-right tabular-nums" data-total="subtotal">
                  {formatMoney(subtotal)}
                </td>
                {!readOnly && <td />}
              </tr>
              <tr>
                <td colSpan={3} className="px-2 py-1 text-right font-semibold">
                  Total
                </td>
                <td className="px-2 py-1 text-right font-semibold tabular-nums" data-total="total">
                  {formatMoney(total)}
                </td>
                {!readOnly && <td />}
              </tr>
            </tfoot>
          </table>
        </div>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mt-1"
            disabled={disabled}
            onClick={() => onDraft({ ...draft, lines: [...draft.lines, blankLine()] })}
          >
            <Plus className="mr-1 size-4" />
            Add line
          </Button>
        )}
        {!readOnly && errors.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-destructive" data-testid="proposal-errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="proposal-notes" className="text-xs">
            Notes (optional)
          </Label>
          <Textarea
            id="proposal-notes"
            rows={3}
            value={draft.notes}
            readOnly={readOnly}
            disabled={disabled}
            onChange={(e) => onDraft({ ...draft, notes: e.target.value })}
          />
        </div>
        <div>
          <Label htmlFor="proposal-terms" className="text-xs">
            Terms (optional)
          </Label>
          <Textarea
            id="proposal-terms"
            rows={3}
            value={draft.terms}
            readOnly={readOnly}
            disabled={disabled}
            onChange={(e) => onDraft({ ...draft, terms: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}
