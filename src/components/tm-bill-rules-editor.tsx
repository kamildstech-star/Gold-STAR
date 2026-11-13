/**
 * The T&M bill's fee and multiplier rules, as a form (TM3). The same form
 * edits Settings (Settings › Operations › T&M rate codes) and one job's
 * override (the T&M bill dialog). A blank box inherits: on a job it follows
 * Settings, in Settings it follows the built-in default — the placeholder
 * shows what it will be.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OVERTIME_LABEL, OVERTIME_MODES, type TmBillRules } from "@/lib/tm-bill-rules";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type NumKey =
  | "smallToolsPercent"
  | "perDiemPerPersonDay"
  | "opPercent"
  | "passThroughMarkupPercent"
  | "dailyOtAfterHours"
  | "weeklyOtAfterHours"
  | "otMultiplier"
  | "afterHoursMultiplier"
  | "weekendMultiplier"
  | "holidayMultiplier"
  | "taxPercent"
  | "ohFeePercent";

const FIELDS: { key: NumKey; label: string; suffix: string }[] = [
  { key: "smallToolsPercent", label: "Small Tools", suffix: "% of labor" },
  { key: "perDiemPerPersonDay", label: "Per Diem", suffix: "$ / person / day" },
  { key: "opPercent", label: "O&P on third-party bills", suffix: "%" },
  { key: "passThroughMarkupPercent", label: "Debris / Hotel markup", suffix: "%" },
  { key: "dailyOtAfterHours", label: "Overtime after", suffix: "h / day" },
  { key: "weeklyOtAfterHours", label: "Weekly overtime after", suffix: "h / week" },
  { key: "otMultiplier", label: "Overtime", suffix: "×" },
  { key: "afterHoursMultiplier", label: "After hours", suffix: "×" },
  { key: "weekendMultiplier", label: "Weekend", suffix: "×" },
  { key: "holidayMultiplier", label: "Holiday", suffix: "×" },
  { key: "taxPercent", label: "Sales tax", suffix: "%" },
  { key: "ohFeePercent", label: "Off-site / OH fee", suffix: "% of sub total" },
];

export function TmBillRulesEditor({
  value,
  inherited,
  laborCodes,
  onSave,
  disabled,
  only,
}: {
  /** What this level sets; a key that is absent inherits. */
  value: Partial<TmBillRules>;
  /** What applies when a box is blank (Settings for a job, defaults for Settings). */
  inherited: TmBillRules;
  /** Labor codes for "field-form crew bills as". */
  laborCodes: readonly { code: string; label: string }[];
  onSave: (next: Partial<TmBillRules>) => Promise<void>;
  disabled?: boolean;
  /** Show only these number fields (the dialog's short list); all when absent. */
  only?: readonly NumKey[];
}) {
  const [draft, setDraft] = useState<Partial<TmBillRules>>(value);
  const [busy, setBusy] = useState(false);
  const text = (k: NumKey) => (draft[k] == null ? "" : String(draft[k]));
  const setNum = (k: NumKey, raw: string) => {
    const next = { ...draft };
    if (raw.trim() === "") delete next[k];
    else (next as Record<string, unknown>)[k] = raw;
    setDraft(next);
  };
  const shown = only ? FIELDS.filter((f) => only.includes(f.key)) : FIELDS;
  const weekend = draft.weekendDays ?? inherited.weekendDays;

  return (
    <form
      className="space-y-3 text-sm"
      data-tm-bill-rules
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await onSave(draft);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((f) => (
          <label key={f.key} className="flex items-center gap-2">
            <span className="w-44 shrink-0 text-xs text-muted-foreground">{f.label}</span>
            <Input
              className="h-8 w-24"
              inputMode="decimal"
              value={text(f.key)}
              placeholder={inherited[f.key] == null ? "off" : String(inherited[f.key])}
              aria-label={f.label}
              disabled={disabled}
              onChange={(e) => setNum(f.key, e.target.value)}
            />
            <span className="text-xs text-muted-foreground">{f.suffix}</span>
          </label>
        ))}
      </div>

      {!only && (
        <>
          <label className="flex flex-wrap items-center gap-2">
            <span className="w-44 shrink-0 text-xs text-muted-foreground">Overtime</span>
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              aria-label="Overtime rule"
              value={draft.overtimeMode ?? ""}
              disabled={disabled}
              onChange={(e) => {
                const next = { ...draft };
                if (e.target.value)
                  next.overtimeMode = e.target.value as TmBillRules["overtimeMode"];
                else delete next.overtimeMode;
                setDraft(next);
              }}
            >
              <option value="">Inherit ({OVERTIME_LABEL[inherited.overtimeMode]})</option>
              {OVERTIME_MODES.map((m) => (
                <option key={m} value={m}>
                  {OVERTIME_LABEL[m]}
                </option>
              ))}
              {draft.overtimeMode === "legacy" && (
                <option value="legacy">{OVERTIME_LABEL.legacy}</option>
              )}
            </select>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-44 shrink-0 text-xs text-muted-foreground">Standard hours</span>
            <Input
              type="time"
              className="h-8 w-28"
              aria-label="Standard day starts"
              value={draft.standardStart ?? ""}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, standardStart: e.target.value })}
            />
            <span className="text-xs">to</span>
            <Input
              type="time"
              className="h-8 w-28"
              aria-label="Standard day ends"
              value={draft.standardEnd ?? ""}
              disabled={disabled}
              onChange={(e) => setDraft({ ...draft, standardEnd: e.target.value })}
            />
            <span className="text-xs text-muted-foreground">
              Blank = no after-hours premium
              {inherited.standardStart && inherited.standardEnd
                ? ` (inherits ${inherited.standardStart}–${inherited.standardEnd})`
                : ""}
              .
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-44 shrink-0 text-xs text-muted-foreground">Weekend days</span>
            {DAYS.map((d, i) => (
              <label key={d} className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={weekend.includes(i)}
                  disabled={disabled}
                  aria-label={`${d} is a weekend day`}
                  onCheckedChange={(v) =>
                    setDraft({
                      ...draft,
                      weekendDays:
                        v === true
                          ? [...new Set([...weekend, i])].sort()
                          : weekend.filter((x) => x !== i),
                    })
                  }
                />
                {d}
              </label>
            ))}
          </div>
          <label className="flex flex-wrap items-center gap-2">
            <span className="w-44 shrink-0 text-xs text-muted-foreground">Holidays</span>
            <Input
              className="h-8 min-w-0 flex-1"
              placeholder="YYYY-MM-DD, YYYY-MM-DD"
              aria-label="Holiday dates"
              value={(draft.holidays ?? []).join(", ")}
              disabled={disabled}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  holidays: e.target.value
                    .split(/[,\s]+/)
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </>
      )}

      <label className="flex flex-wrap items-center gap-2">
        <Label className="w-44 shrink-0 text-xs font-normal text-muted-foreground">
          Field-form crew bills as
        </Label>
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          aria-label="Labor code for field-form crew"
          value={draft.fieldFormCode ?? ""}
          disabled={disabled}
          onChange={(e) => setDraft({ ...draft, fieldFormCode: e.target.value || null })}
        >
          <option value="">
            {inherited.fieldFormCode ? `Inherit (${inherited.fieldFormCode})` : "Not chosen"}
          </option>
          {laborCodes.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.label}
            </option>
          ))}
        </select>
      </label>

      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={disabled || busy}>
          {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Save rules
        </Button>
      </div>
    </form>
  );
}
