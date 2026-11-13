import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  CalendarDays,
  Clock3,
  Info,
  Percent,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { SaveBar } from "@/components/billing-costs/save-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import { getMarginThreshold } from "@/lib/running-cost";
import { cn } from "@/lib/utils";
import { loadCatalog } from "@/lib/catalog";
import {
  CHARGE_KINDS,
  CHARGE_KIND_LABEL,
  EMPTY_GENERAL_DRAFT,
  LANDING_LABEL,
  STANDARD_CHARGE_HELP,
  generalDraftSize,
  generalDraftToSave,
  isPercentKind,
  isoToUsDate,
  landingsFor,
  usDateToIso,
  validateGeneralDraft,
  type ChargeEdit,
  type GeneralDraft,
  type NewCharge,
  type RulesDraft,
} from "@/lib/general-rules";
import {
  OVERTIME_LABEL,
  OVERTIME_MODES,
  type ChargeKind,
  type OvertimeMode,
} from "@/lib/tm-bill-rules";
import { loadGeneralRules, saveGeneralRules, type ChargeRow } from "@/lib/tm-bill-rules-store";

const RULES_KEY = ["billing-costs", "general-rules"] as const;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The company's billing rules (prompt 2's General rules), shown where each
 * applies. `part="tm"` is T&M Rates › T&M Rules: charges (the five standard
 * ones and any added), the time rules (standard hours, weekend days,
 * holidays, one overtime rule and the multipliers) and the field-form crew's
 * labor code. `part="cost"` is Cost › Cost Rules: the minimum margin guard.
 * One row, one Save (billing_rules_save) behind both. No tax: that stays on
 * each job. A job can still override any rule from its T&M bill.
 */
export function RulesPanel({ part }: { part: "tm" | "cost" }) {
  const title = part === "tm" ? "T&M rules" : "Cost rules";
  const qc = useQueryClient();
  const app = useAppContext();
  const canEdit = isPrivileged(app.realRoles ?? []);
  const q = useQuery({ queryKey: RULES_KEY, queryFn: () => loadGeneralRules(supabase as never) });
  const marginQ = useQuery({ queryKey: ["margin-threshold"], queryFn: getMarginThreshold });
  const laborQ = useQuery({ queryKey: ["billing-costs", "catalog"], queryFn: () => loadCatalog() });

  const [draft, setDraft] = useState<GeneralDraft>(EMPTY_GENERAL_DRAFT);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [holidayInput, setHolidayInput] = useState("");
  const [holidayError, setHolidayError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const row = q.data?.row ?? null;
  const charges = useMemo(() => q.data?.charges ?? [], [q.data]);
  const problems = useMemo(
    () => (row ? validateGeneralDraft(row, charges, draft) : new Map<string, string>()),
    [row, charges, draft],
  );
  const pending = generalDraftSize(draft);

  if (q.isError) return <LoadError what={`the ${title}`} error={q.error} />;
  if (q.isLoading || !q.data) {
    return <p className="p-3 text-sm text-muted-foreground">Loading the {title}…</p>;
  }
  if (!q.data.fromStore || !row) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4 text-sm">
          <p className="font-medium">The {title} are not available yet.</p>
          <p className="text-muted-foreground">
            The database update that holds them (migration 20261030120000) has not been applied
            here. Until it is, the T&amp;M bill uses the rules exactly as they were.
          </p>
        </CardContent>
      </Card>
    );
  }

  const original: RulesDraft = {
    standard_start: row.standard_start,
    standard_end: row.standard_end,
    overtime_mode: row.overtime_mode as OvertimeMode,
    daily_ot_after_hours:
      row.daily_ot_after_hours == null ? "" : String(Number(row.daily_ot_after_hours)),
    weekly_ot_after_hours: String(Number(row.weekly_ot_after_hours)),
    weekend_days: row.weekend_days,
    holidays: row.holidays,
    ot_multiplier: String(Number(row.ot_multiplier)),
    after_hours_multiplier: String(Number(row.after_hours_multiplier)),
    weekend_multiplier: String(Number(row.weekend_multiplier)),
    holiday_multiplier: String(Number(row.holiday_multiplier)),
    field_form_code: row.field_form_code,
    minimum_margin_percent: marginQ.data == null ? "" : String(marginQ.data),
  };
  const v = <K extends keyof RulesDraft>(k: K): RulesDraft[K] =>
    (k in draft.rules ? draft.rules[k] : original[k]) as RulesDraft[K];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  function setRule<K extends keyof RulesDraft>(k: K, value: RulesDraft[K]) {
    setDraft((d) => {
      const rules = { ...d.rules };
      if (same(value, original[k])) delete rules[k];
      else rules[k] = value;
      return { ...d, rules };
    });
  }

  function editCharge(c: ChargeRow, patch: ChargeEdit) {
    setDraft((d) => {
      const merged = { ...d.charges[c.key], ...patch };
      const base = {
        name: c.name,
        value: c.value == null ? "" : String(Number(c.value)),
        active: c.active,
        archived: c.archived_at != null,
      };
      for (const k of Object.keys(merged) as (keyof ChargeEdit)[]) {
        if (same(merged[k], base[k])) delete merged[k];
      }
      const next = { ...d.charges };
      if (Object.keys(merged).length) next[c.key] = merged;
      else delete next[c.key];
      return { ...d, charges: next };
    });
  }

  function addCharge() {
    const tempId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setDraft((d) => ({
      ...d,
      creates: [...d.creates, { tempId, name: "", kind: "", value: "", lands_on: "" }],
    }));
  }
  function editNew(tempId: string, patch: Partial<NewCharge>) {
    setDraft((d) => ({
      ...d,
      creates: d.creates.map((c) => (c.tempId === tempId ? { ...c, ...patch } : c)),
    }));
  }

  function addHoliday() {
    const iso = usDateToIso(holidayInput);
    if (!iso) {
      setHolidayError("Enter a real date as MM/DD/YYYY, like 12/25/2026.");
      return;
    }
    const list = v("holidays") ?? [];
    if (list.includes(iso)) {
      setHolidayError(`${holidayInput.trim()} is already a holiday.`);
      return;
    }
    setRule("holidays", [...list, iso].sort());
    setHolidayInput("");
    setHolidayError(null);
  }

  async function save() {
    if (problems.size || !pending) return;
    setSaving(true);
    try {
      const { rules, charges: changes } = generalDraftToSave(draft);
      await saveGeneralRules(supabase as never, rules, changes, note);
      toast.success(`${part === "tm" ? "T&M" : "Cost"} rules saved`);
      setDraft(EMPTY_GENERAL_DRAFT);
      setNote("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: RULES_KEY }),
        qc.invalidateQueries({ queryKey: ["margin-threshold"] }),
      ]);
    } catch (err) {
      toastDbError(err, { action: `Saving the ${title}` });
    } finally {
      setSaving(false);
    }
  }

  const err = (key: string) => problems.get(key);
  const mode = v("overtime_mode") as OvertimeMode | "legacy_both";
  const labor = (laborQ.data?.items ?? []).filter(
    (i) => i.category === "labor" && i.active && !i.archived_at,
  );
  const live = charges.filter((c) => !c.archived_at || draft.charges[c.key]?.archived === false);
  const archived = charges.filter((c) => c.archived_at && draft.charges[c.key]?.archived !== false);

  return (
    <TooltipProvider delayDuration={250}>
      <div className={cn("space-y-3", pending > 0 && "pb-28 md:pb-20")}>
        <p className="text-xs text-muted-foreground">
          {part === "tm"
            ? "Company-wide rules for the T&M bill. A job can override any of these from its T&M bill; tax stays on each job."
            : "Company-wide rules for what things cost against what they bill."}
        </p>
        {part === "tm" && (
          <>
            {/* Charges */}
            <Card data-general-charges>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Percent className="h-4 w-4 text-muted-foreground" aria-hidden /> Charges on the
                  bill
                </CardTitle>
                {canEdit && (
                  <Button variant="outline" className="h-11 md:h-8" onClick={addCharge}>
                    <Plus aria-hidden /> Add charge
                  </Button>
                )}
              </CardHeader>
              <CardContent className="p-0">
                <div className="hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-y bg-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[minmax(0,1.4fr)_10rem_8rem_minmax(0,1.3fr)_6rem_2.5rem] md:gap-3">
                  <span>Charge</span>
                  <span>Charged on</span>
                  <span>Value</span>
                  <span>Lands on the bill</span>
                  <span>Status</span>
                  <span className="sr-only">Archive</span>
                </div>
                <div className="space-y-2 p-2 md:space-y-0 md:divide-y md:p-0">
                  {live.map((c) => (
                    <ChargeRowView
                      key={c.key}
                      c={c}
                      edit={draft.charges[c.key]}
                      canEdit={canEdit}
                      err={err}
                      onEdit={(p) => editCharge(c, p)}
                    />
                  ))}
                  {draft.creates.map((n) => (
                    <NewChargeRow
                      key={n.tempId}
                      n={n}
                      err={err}
                      onEdit={(p) => editNew(n.tempId, p)}
                      onRemove={() =>
                        setDraft((d) => ({
                          ...d,
                          creates: d.creates.filter((x) => x.tempId !== n.tempId),
                        }))
                      }
                    />
                  ))}
                </div>
                {archived.length > 0 && (
                  <div className="border-t px-3 py-2">
                    <button
                      type="button"
                      className="text-sm font-medium text-muted-foreground hover:text-foreground"
                      onClick={() => setShowArchived((s) => !s)}
                    >
                      Archived <Badge variant="secondary">{archived.length}</Badge>
                    </button>
                    {showArchived && (
                      <ul className="mt-2 space-y-1">
                        {archived.map((c) => (
                          <li
                            key={c.key}
                            className="flex items-center gap-2 text-sm text-muted-foreground"
                          >
                            <span className="flex-1">
                              {c.name} · {CHARGE_KIND_LABEL[c.kind]}
                            </span>
                            {canEdit && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => editCharge(c, { archived: false })}
                              >
                                <ArchiveRestore aria-hidden /> Restore
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Time rules */}
            <Card data-general-time>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden /> Time rules
                </CardTitle>
                <p className="text-xs text-muted-foreground">Apply to T&amp;M billing now.</p>
              </CardHeader>
              <CardContent className="grid gap-x-8 gap-y-4 lg:grid-cols-2">
                <div className="space-y-4">
                  <Field stacked label="Standard hours" error={err("rules.standard_end")}>
                    {!canEdit ? (
                      <ReadText>
                        {clock(v("standard_start"))} to {clock(v("standard_end"))}
                      </ReadText>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          type="time"
                          className="h-11 w-32 md:h-8"
                          aria-label="Standard day starts"
                          value={v("standard_start") ?? ""}
                          onChange={(e) => setRule("standard_start", e.target.value)}
                        />
                        <span className="text-xs text-muted-foreground">to</span>
                        <Input
                          type="time"
                          className="h-11 w-32 md:h-8"
                          aria-label="Standard day ends"
                          value={v("standard_end") ?? ""}
                          onChange={(e) => setRule("standard_end", e.target.value)}
                        />
                      </div>
                    )}
                  </Field>

                  <Field stacked label="Weekend days">
                    {!canEdit ? (
                      <ReadText>
                        {DAYS.filter((_, i) => (v("weekend_days") ?? []).includes(i)).join(", ") ||
                          "None"}
                      </ReadText>
                    ) : (
                      <div className="flex flex-wrap gap-3">
                        {DAYS.map((d, i) => {
                          const days = v("weekend_days") ?? [];
                          return (
                            <label key={d} className="flex items-center gap-1.5 text-sm">
                              <Checkbox
                                checked={days.includes(i)}
                                aria-label={`${d} is a weekend day`}
                                onCheckedChange={(on) =>
                                  setRule(
                                    "weekend_days",
                                    on === true
                                      ? [...new Set([...days, i])].sort()
                                      : days.filter((x) => x !== i),
                                  )
                                }
                              />
                              {d}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </Field>

                  <Field stacked label="Holidays" error={holidayError ?? undefined}>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-1.5">
                        {(v("holidays") ?? []).length === 0 && (
                          <span className="text-xs text-muted-foreground">No holidays set.</span>
                        )}
                        {(v("holidays") ?? []).map((iso) => (
                          <span
                            key={iso}
                            className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 text-xs"
                          >
                            <CalendarDays className="h-3 w-3 text-muted-foreground" aria-hidden />
                            {isoToUsDate(iso)}
                            {canEdit && (
                              <button
                                type="button"
                                aria-label={`Remove ${isoToUsDate(iso)}`}
                                className="text-muted-foreground hover:text-foreground"
                                onClick={() =>
                                  setRule(
                                    "holidays",
                                    (v("holidays") ?? []).filter((x) => x !== iso),
                                  )
                                }
                              >
                                <X className="h-3 w-3" aria-hidden />
                              </button>
                            )}
                          </span>
                        ))}
                      </div>
                      {canEdit && (
                        <form
                          className="flex flex-wrap gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            addHoliday();
                          }}
                        >
                          <Input
                            value={holidayInput}
                            onChange={(e) => {
                              setHolidayInput(e.target.value);
                              setHolidayError(null);
                            }}
                            placeholder="MM/DD/YYYY"
                            aria-label="Add a holiday date"
                            aria-invalid={holidayError ? true : undefined}
                            inputMode="numeric"
                            className={cn("h-11 w-36 md:h-8", holidayError && "border-destructive")}
                          />
                          <Button type="submit" variant="outline" className="h-11 md:h-8">
                            Add holiday
                          </Button>
                        </form>
                      )}
                    </div>
                  </Field>
                </div>

                <div className="space-y-4">
                  <Field stacked label="Overtime" error={err("rules.overtime_mode")}>
                    {mode === "legacy_both" && (
                      <p className="mb-2 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                        <AlertTriangle
                          className="mt-px h-3.5 w-3.5 shrink-0 text-warning"
                          aria-hidden
                        />
                        The old Settings applied both a daily threshold and after-hours at once, and
                        bills still do until you choose one rule below.
                      </p>
                    )}
                    {!canEdit ? (
                      <ReadText>
                        {mode === "daily"
                          ? `After ${v("daily_ot_after_hours") || "—"} hours a day`
                          : mode === "weekly"
                            ? `After ${v("weekly_ot_after_hours") || "—"} hours a week (Monday–Sunday, per person)`
                            : mode === "legacy_both"
                              ? OVERTIME_LABEL.legacy
                              : OVERTIME_LABEL[mode]}
                      </ReadText>
                    ) : (
                      <RadioGroup
                        value={mode === "legacy_both" ? "" : mode}
                        onValueChange={(m) => setRule("overtime_mode", m as OvertimeMode)}
                        className="space-y-2"
                      >
                        {OVERTIME_MODES.map((m) => (
                          <div key={m} className="flex flex-wrap items-center gap-2">
                            <RadioGroupItem value={m} id={`ot-${m}`} />
                            <label htmlFor={`ot-${m}`} className="text-sm">
                              {m === "daily"
                                ? "After"
                                : m === "weekly"
                                  ? "After"
                                  : OVERTIME_LABEL[m]}
                            </label>
                            {m === "daily" && (
                              <>
                                <NumBox
                                  value={v("daily_ot_after_hours") ?? ""}
                                  label="Hours a day before overtime"
                                  invalid={!!err("rules.daily_ot_after_hours")}
                                  onChange={(x) => setRule("daily_ot_after_hours", x)}
                                />
                                <span className="text-sm">hours a day</span>
                              </>
                            )}
                            {m === "weekly" && (
                              <>
                                <NumBox
                                  value={v("weekly_ot_after_hours") ?? ""}
                                  label="Hours a week before overtime"
                                  invalid={!!err("rules.weekly_ot_after_hours")}
                                  onChange={(x) => setRule("weekly_ot_after_hours", x)}
                                />
                                <span className="text-sm">
                                  hours a week (Monday–Sunday, per person)
                                </span>
                              </>
                            )}
                            {m === "after_hours" && (
                              <span className="text-xs text-muted-foreground">
                                — outside the standard hours above
                              </span>
                            )}
                          </div>
                        ))}
                      </RadioGroup>
                    )}
                    {(err("rules.daily_ot_after_hours") || err("rules.weekly_ot_after_hours")) && (
                      <p className="mt-1 text-xs text-destructive">
                        {err("rules.daily_ot_after_hours") ?? err("rules.weekly_ot_after_hours")}
                      </p>
                    )}
                  </Field>

                  <Field stacked label="Multipliers">
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {(
                        [
                          ["ot_multiplier", "Overtime"],
                          ["after_hours_multiplier", "After hours"],
                          ["weekend_multiplier", "Weekend"],
                          ["holiday_multiplier", "Holiday"],
                        ] as const
                      ).map(([k, label]) => (
                        <label key={k} className="min-w-0 space-y-1 [&_input]:w-full">
                          <span className="block text-xs text-muted-foreground">{label} ×</span>
                          <NumBox
                            value={v(k) ?? ""}
                            label={`${label} multiplier`}
                            readOnly={!canEdit}
                            invalid={!!err(`rules.${k}`)}
                            onChange={(x) => setRule(k, x)}
                          />
                          {err(`rules.${k}`) && (
                            <span className="block text-xs text-destructive">
                              {err(`rules.${k}`)}
                            </span>
                          )}
                        </label>
                      ))}
                    </div>
                  </Field>

                  <Field stacked label="Field-form crew bills as">
                    {!canEdit ? (
                      <ReadText>
                        {(() => {
                          const code = v("field_form_code");
                          const hit = labor.find((c) => c.code === code);
                          return !code ? "Not chosen" : hit ? `${hit.code} — ${hit.name}` : code;
                        })()}
                      </ReadText>
                    ) : (
                      <Select
                        value={v("field_form_code") ?? "none"}
                        onValueChange={(x) => setRule("field_form_code", x === "none" ? null : x)}
                      >
                        <SelectTrigger
                          className="h-11 w-full sm:w-80 md:h-8"
                          aria-label="Labor code for field-form crew"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Not chosen</SelectItem>
                          {labor.map((c) => (
                            <SelectItem key={c.code} value={c.code}>
                              {c.code} — {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </Field>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {part === "cost" && (
          /* Minimum margin */
          <Card data-general-margin>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden /> Minimum margin
                guard
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Field label="Company default" error={err("rules.minimum_margin_percent")}>
                <div className="flex flex-wrap items-center gap-2">
                  <NumBox
                    value={v("minimum_margin_percent") ?? ""}
                    label="Minimum margin percent"
                    readOnly={!canEdit}
                    invalid={!!err("rules.minimum_margin_percent")}
                    onChange={(x) => setRule("minimum_margin_percent", x)}
                  />
                  <span className="text-sm">%</span>
                  <span className="text-xs text-muted-foreground">
                    Rates below it are flagged in T&amp;M Rates; job margins below it show in
                    warning color.
                  </span>
                </div>
              </Field>
            </CardContent>
          </Card>
        )}

        {canEdit && (
          <p className="text-xs text-muted-foreground">
            Every change is recorded with who made it and your note.
          </p>
        )}

        {canEdit && (
          <SaveBar
            pending={pending}
            problems={problems.size}
            note={note}
            onNote={setNote}
            saving={saving}
            onSave={() => void save()}
            onDiscard={() => {
              setDraft(EMPTY_GENERAL_DRAFT);
              setNote("");
              setHolidayError(null);
            }}
            hint="New bills use these once saved. Jobs that override a rule keep their own."
          />
        )}
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ parts */

function Field({
  label,
  error,
  stacked,
  children,
}: {
  label: string;
  error?: string;
  /** Label above the control — for a half-width column. */
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", !stacked && "md:grid-cols-[12rem_minmax(0,1fr)] md:gap-4")}>
      <span className="pt-1.5 text-sm font-medium">{label}</span>
      <div>
        {children}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/** A rule's value, as text, for someone who may read the rules but not change them. */
function ReadText({ children }: { children: React.ReactNode }) {
  return <p className="pt-1.5 text-sm tabular-nums">{children}</p>;
}

/** "07:00" → "7:00 AM"; nothing set → "Not set". */
function clock(hhmm: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm ?? "");
  if (!m) return "Not set";
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

function NumBox({
  value,
  label,
  readOnly,
  invalid,
  onChange,
}: {
  value: string;
  label: string;
  /** Shown as text: the rule may be read but not changed by this person. */
  readOnly?: boolean;
  invalid?: boolean;
  onChange: (v: string) => void;
}) {
  if (readOnly)
    return (
      <span aria-label={label} className="inline-block pt-1.5 text-sm tabular-nums">
        {value === "" ? "Not set" : value}
      </span>
    );
  return (
    <Input
      value={value}
      inputMode="decimal"
      aria-label={label}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      className={cn("h-11 w-24 tabular-nums md:h-8", invalid && "border-destructive")}
    />
  );
}

const GRID =
  "space-y-2 rounded-lg border p-3 md:grid md:grid-cols-[minmax(0,1.4fr)_10rem_8rem_minmax(0,1.3fr)_6rem_2.5rem] md:items-start md:gap-3 md:space-y-0 md:rounded-none md:border-0 md:px-3 md:py-2";

function ChargeRowView({
  c,
  edit,
  canEdit,
  err,
  onEdit,
}: {
  c: ChargeRow;
  edit: ChargeEdit | undefined;
  canEdit: boolean;
  err: (k: string) => string | undefined;
  onEdit: (p: ChargeEdit) => void;
}) {
  const name = edit?.name ?? c.name;
  const value = edit?.value ?? (c.value == null ? "" : String(Number(c.value)));
  const active = edit?.active ?? c.active;
  const pct = isPercentKind(c.kind);
  return (
    <div
      data-charge-row={c.key}
      className={cn(GRID, edit && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]")}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {canEdit ? (
            <Input
              value={name}
              onChange={(e) => onEdit({ name: e.target.value })}
              aria-label={`Name of ${c.name}`}
              aria-invalid={!!err(`charge.${c.key}.name`) || undefined}
              className={cn("h-11 md:h-8", err(`charge.${c.key}.name`) && "border-destructive")}
            />
          ) : (
            <span className="pt-1.5 text-sm font-medium">{name}</span>
          )}
          {c.system && STANDARD_CHARGE_HELP[c.key] && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Info
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                  aria-label={`About ${c.name}`}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{STANDARD_CHARGE_HELP[c.key]}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {err(`charge.${c.key}.name`) && (
          <p className="mt-1 text-xs text-destructive">{err(`charge.${c.key}.name`)}</p>
        )}
      </div>
      <span className="block pt-1.5 text-sm text-muted-foreground">
        {CHARGE_KIND_LABEL[c.kind]}
      </span>
      <div>
        <div className="flex items-center gap-1">
          {!pct && <span className="text-sm text-muted-foreground">$</span>}
          <NumBox
            value={value}
            label={`Value of ${c.name}`}
            readOnly={!canEdit}
            invalid={!!err(`charge.${c.key}.value`)}
            onChange={(x) => onEdit({ value: x })}
          />
          {pct && <span className="text-sm text-muted-foreground">%</span>}
        </div>
        {err(`charge.${c.key}.value`) && (
          <p className="mt-1 text-xs text-destructive">{err(`charge.${c.key}.value`)}</p>
        )}
      </div>
      <span className="block pt-1.5 text-sm text-muted-foreground">
        {LANDING_LABEL(c.lands_on)}
      </span>
      <div className="flex items-center gap-2 pt-1">
        {c.system ? (
          <Badge variant="outline">Standard</Badge>
        ) : !canEdit ? (
          <span className="text-xs text-muted-foreground">{active ? "On" : "Off"}</span>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={active}
              onCheckedChange={(on) => onEdit({ active: on })}
              aria-label={`${c.name} active`}
            />
            {active ? "On" : "Off"}
          </label>
        )}
      </div>
      <div>
        {!c.system && canEdit && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-11 w-11 md:h-8 md:w-8"
                aria-label={`Archive ${c.name}`}
                onClick={() => onEdit({ archived: true })}
              >
                <Archive aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Archive — kept for history, never deleted</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function NewChargeRow({
  n,
  err,
  onEdit,
  onRemove,
}: {
  n: NewCharge;
  err: (k: string) => string | undefined;
  onEdit: (p: Partial<NewCharge>) => void;
  onRemove: () => void;
}) {
  const e = (f: string) => err(`new.${n.tempId}.${f}`);
  const kinds = CHARGE_KINDS as readonly ChargeKind[];
  return (
    <div data-charge-new className={cn(GRID, "border-dashed bg-[var(--label-blue)]")}>
      <div>
        <Input
          value={n.name}
          onChange={(x) => onEdit({ name: x.target.value })}
          placeholder="Charge name"
          aria-label="New charge name"
          aria-invalid={!!e("name") || undefined}
          className={cn("h-11 md:h-8", e("name") && "border-destructive")}
        />
        {e("name") && <p className="mt-1 text-xs text-destructive">{e("name")}</p>}
      </div>
      <div>
        <Select
          value={n.kind}
          onValueChange={(k) => {
            const kind = k as ChargeKind;
            onEdit({
              kind,
              lands_on: landingsFor(kind).includes(n.lands_on as never)
                ? n.lands_on
                : kind === "pct_subtotal"
                  ? "other_fees"
                  : "",
            });
          }}
        >
          <SelectTrigger
            className={cn("h-11 md:h-8", e("kind") && "border-destructive")}
            aria-label="New charge is charged on"
          >
            <SelectValue placeholder="Charged on…" />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {CHARGE_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {e("kind") && <p className="mt-1 text-xs text-destructive">{e("kind")}</p>}
      </div>
      <div>
        <NumBox
          value={n.value}
          label="New charge value"
          invalid={!!e("value")}
          onChange={(x) => onEdit({ value: x })}
        />
        {e("value") && <p className="mt-1 text-xs text-destructive">{e("value")}</p>}
      </div>
      <div>
        <Select
          value={n.lands_on}
          onValueChange={(l) => onEdit({ lands_on: l as NewCharge["lands_on"] })}
          disabled={!n.kind}
        >
          <SelectTrigger
            className={cn("h-11 md:h-8", e("lands_on") && "border-destructive")}
            aria-label="Where the new charge lands"
          >
            <SelectValue placeholder="Lands on…" />
          </SelectTrigger>
          <SelectContent>
            {(n.kind ? landingsFor(n.kind) : []).map((l) => (
              <SelectItem key={l} value={l}>
                {LANDING_LABEL(l)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {e("lands_on") && <p className="mt-1 text-xs text-destructive">{e("lands_on")}</p>}
      </div>
      <span className="block pt-1.5 text-xs text-muted-foreground">On once saved</span>
      <div className="flex justify-end md:block">
        <Button
          variant="ghost"
          size="icon"
          className="h-11 w-11 md:h-8 md:w-8"
          onClick={onRemove}
          aria-label="Remove this new charge"
        >
          <X aria-hidden />
        </Button>
      </div>
    </div>
  );
}
