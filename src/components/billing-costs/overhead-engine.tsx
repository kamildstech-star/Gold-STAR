import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Archive, Building2, Calculator, Plus, RefreshCw, RotateCcw, Ruler } from "lucide-react";

import { HistoryButton } from "@/components/billing-costs/history";
import { SaveBar } from "@/components/billing-costs/save-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import { formatDateUS } from "@/lib/date-format";
import { resolveOfficeValue } from "@/lib/office-values";
import {
  OVERHEAD_LENS,
  compareEngine,
  engineAt,
  engineCellKey,
  engineDraftToChanges,
  engineTimeline,
  explainCompare,
  isFleetComponent,
  HOUR_UNIT,
  perHour,
  saveOverhead,
  typedAmount,
  unitOf,
  type EngineDraft,
  type LegacyLaborRate,
  type OverheadData,
  type OverheadUnit,
} from "@/lib/overhead";
import { parseMoney, type Office } from "@/lib/tm-rates";
import { useMyPageAccess } from "@/lib/use-page-access";
import { cn } from "@/lib/utils";

const localToday = () => new Date().toLocaleDateString("en-CA");
const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);
/** A typed amount in a unit, per hour; null = blank, NaN = not money. */
const perHourOf = (typed: string, unit: OverheadUnit): number | null => {
  const v = parseMoney(typed);
  return v == null || Number.isNaN(v) ? v : perHour(v, unit);
};

type Pending = {
  draft: EngineDraft;
  added: { name: string; value: string; note: string; unit: string }[];
  archived: string[];
  temp: { value: string } | { reset: true } | null;
  /** A component switched to another unit (key → unit key). */
  units: Readonly<Record<string, string>>;
  /** A component renamed or its note changed. */
  edits: Readonly<Record<string, { name?: string; note?: string }>>;
};
const EMPTY: Pending = { draft: {}, added: [], archived: [], temp: null, units: {}, edits: {} };

/**
 * Billing & Costs › Cost › Overhead engine (prompt 3; owner and admin only):
 * what a field-labor hour really costs — Wage, General liability, Workers'
 * comp and any added component, per office or company default — summed live.
 * Publishing writes the sum onto every field labor title's cost from its date.
 * Effective-dated and never edited; every change needs a note. Rules in
 * src/lib/overhead.ts; the database's overhead_save does the publishing.
 */
export function OverheadEngine({
  data,
  offices,
  queryKeys,
}: {
  data: OverheadData;
  offices: Office[];
  queryKeys: readonly (readonly string[])[];
}) {
  // The Fleet link only for someone who can open Fleet; otherwise the note reads plain.
  const canOpenFleet = useMyPageAccess().canOpen("/fleet");
  const qc = useQueryClient();
  const today = localToday();
  const [office, setOffice] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(EMPTY);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [adding, setAdding] = useState({ name: "", value: "", note: "", unit: "hour" });
  const [unitsOpen, setUnitsOpen] = useState(false);
  const units = data.units?.length ? data.units : [HOUR_UNIT];
  const unitById = (key: string) => unitOf(units, { unit_key: key });
  /** The unit a component is entered in, after Save. */
  const unitFor = (key: string) =>
    unitById(pending.units[key] ?? data.components.find((c) => c.key === key)?.unit_key ?? "hour");

  const live = data.components.filter((c) => !c.archived_at);
  const archivedComps = data.components.filter((c) => c.archived_at);
  const officeName = (id: string | null) =>
    id ? (offices.find((o) => o.id === id)?.name ?? "Office") : "Company default";

  /** The rows as they will be after Save, for the live figure. */
  const extra = Object.entries(pending.draft).map(([id, e]) => {
    const at = id.lastIndexOf("|");
    const scope = id.slice(at + 1);
    return {
      ...OVERHEAD_LENS,
      item_key: id.slice(0, at),
      office_id: scope === "default" ? null : scope,
      effective_from: today,
      value: "reset" in e ? null : (perHourOf(e.value, unitFor(id.slice(0, at))) ?? null),
    };
  });
  const previewRows = [
    ...data.rows.filter(
      (r) =>
        !(
          r.effective_from === today &&
          extra.some((x) => x.item_key === r.item_key && x.office_id === r.office_id)
        ),
    ),
    ...extra,
  ].map((r) => ({ ...r, value: Number.isNaN(r.value as number) ? null : r.value }));
  const previewComponents = useMemo(
    () => [
      ...data.components.map((c) =>
        pending.archived.includes(c.key) ? { ...c, archived_at: `${today}T00:00:00Z` } : c,
      ),
      ...pending.added.map((a, i) => ({
        key: `new_${i}`,
        name: a.name,
        note: a.note || null,
        system: false,
        sort_order: 100000 + i,
        archived_at: null,
      })),
    ],
    [data.components, pending.added, pending.archived, today],
  );
  const previewWithAdded = [
    ...previewRows,
    ...pending.added.map((a, i) => ({
      ...OVERHEAD_LENS,
      item_key: `new_${i}`,
      office_id: null,
      effective_from: today,
      value: perHourOf(a.value, unitById(a.unit)) ?? null,
    })),
  ];
  const now = engineAt(data.rows, data.components, office, today);
  const after = engineAt(previewWithAdded, previewComponents, office, today);

  const problems = new Map<string, string>();
  for (const [id, e] of Object.entries(pending.draft)) {
    if ("reset" in e) continue;
    const v = parseMoney(e.value);
    if (v == null || Number.isNaN(v)) problems.set(id, "Dollars and cents, like 3 or 1.25.");
  }
  if (pending.temp && "value" in pending.temp) {
    const v = parseMoney(pending.temp.value);
    if (v == null || Number.isNaN(v)) problems.set("temp", "Dollars and cents per hour.");
  }
  for (const [key, e] of Object.entries(pending.edits)) {
    if (e.name !== undefined && !e.name.trim())
      problems.set(`name|${key}`, "A component needs a name.");
  }
  const count =
    Object.keys(pending.draft).length +
    pending.added.length +
    pending.archived.length +
    Object.keys(pending.units).length +
    Object.keys(pending.edits).length +
    (pending.temp ? 1 : 0);

  function edit(component: string, value: string) {
    setPending((p) => ({
      ...p,
      draft: { ...p.draft, [engineCellKey(component, office)]: { value } },
    }));
  }
  /** A rename or note change; back to the saved text drops it. */
  function editComponent(key: string, patch: { name?: string; note?: string }) {
    const c = data.components.find((x) => x.key === key);
    setPending((p) => {
      const next = { ...p.edits[key], ...patch };
      if (next.name !== undefined && next.name === c?.name) delete next.name;
      if (next.note !== undefined && next.note === (c?.note ?? "")) delete next.note;
      const edits = { ...p.edits };
      if (Object.keys(next).length) edits[key] = next;
      else delete edits[key];
      return { ...p, edits };
    });
  }
  function reset(component: string) {
    setPending((p) => ({
      ...p,
      draft: { ...p.draft, [engineCellKey(component, office)]: { reset: true } },
    }));
  }
  function discard() {
    setPending(EMPTY);
    setNote("");
    setEffectiveFrom(localToday());
  }
  async function refresh() {
    for (const k of queryKeys) await qc.invalidateQueries({ queryKey: [...k] });
  }

  async function save() {
    if (problems.size || !count || !note.trim()) return;
    if (effectiveFrom < today) {
      toast.error("A change can take effect today or later.");
      return;
    }
    const eff = effectiveFrom > today ? effectiveFrom : "";
    const changes: Record<string, unknown>[] = [
      // Units first, so a value typed in the new unit is read in it.
      ...Object.entries(pending.units).map(([component, unit]) => ({
        op: "set_unit",
        component,
        unit,
      })),
      ...Object.entries(pending.edits).map(([component, e]) => ({
        op: "edit",
        component,
        ...e,
      })),
      ...engineDraftToChanges(pending.draft, eff, unitFor),
      ...pending.added.map((a) => {
        const amount = parseMoney(a.value) ?? null;
        const unit = unitById(a.unit);
        return {
          op: "add",
          name: a.name,
          note: a.note,
          value: amount == null ? null : perHour(amount, unit),
          ...(amount != null && unit.key !== "hour" ? { amount, unit: unit.key } : {}),
          ...(unit.key !== "hour" ? { unit: unit.key } : {}),
          effective_from: eff,
        };
      }),
      ...pending.archived.map((k) => ({ op: "archive", component: k })),
    ];
    if (pending.temp) {
      changes.push({
        op: "temp_wage",
        office_id: office,
        value: "reset" in pending.temp ? null : parseMoney(pending.temp.value),
        effective_from: eff,
      });
    }
    setSaving(true);
    try {
      const n = await saveOverhead(changes, note);
      toast.success(`Published ${n} change${n === 1 ? "" : "s"}`, {
        description: "Field labor costs follow from the same date.",
      });
      discard();
      await refresh();
    } catch (err) {
      toastDbError(err, { action: "Publishing the overhead engine" });
    } finally {
      setSaving(false);
    }
  }

  const tempNow = currentTemp(data.labour, office, today);

  return (
    <div className={cn("space-y-3", count > 0 && "pb-36 md:pb-24")} data-overhead-engine>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <Calculator className="h-5 w-5 text-muted-foreground" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">
              True cost per field-labor hour · {officeName(office)}
            </p>
            <p className="text-2xl font-semibold tabular-nums" data-engine-total>
              {usd(after.total)}
              {after.total !== now.total && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  now {usd(now.total)}
                </span>
              )}
            </p>
            {after.missing.length > 0 && (
              <p className="text-xs text-warning">
                No value yet for {after.missing.join(", ")} — counted as $0.
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={office ?? "default"}
              onValueChange={(v) => setOffice(v === "default" ? null : v)}
            >
              <SelectTrigger className="h-11 w-full sm:w-56 md:h-8" aria-label="Office">
                <Building2 className="mr-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Company default</SelectItem>
                {offices.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ApplyButton onDone={refresh} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-2">
          <div className="min-w-0 flex-1 basis-64">
            <CardTitle className="text-sm">Components</CardTitle>
            <p className="text-xs text-muted-foreground">
              Each is entered in its own unit — per hour, day, month, year — and counted per
              field-labor hour (amount ÷ the unit&rsquo;s hours). Set for the company and, where an
              office differs, for that office. Their sum becomes every field title&rsquo;s cost in
              the Cost tab.
            </p>
          </div>
          {data.unitsAvailable && (
            <Button
              variant="outline"
              className="h-11 md:h-8"
              onClick={() => setUnitsOpen(true)}
              data-manage-units
            >
              <Ruler aria-hidden /> Units
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-2 p-0 pb-2">
          <div className="hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-y bg-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[minmax(0,1fr)_17rem_minmax(0,1fr)_5rem] md:gap-3">
            <span>Component</span>
            <span>Amount · unit</span>
            <span>Note</span>
            <span />
          </div>
          <ul className="space-y-2 px-3 md:space-y-0 md:divide-y md:px-0">
            {live.map((c) => {
              const id = engineCellKey(c.key, office);
              const e = pending.draft[id];
              const saved = resolveOfficeValue(
                data.rows,
                { ...OVERHEAD_LENS, item_key: c.key },
                office,
                today,
              );
              const own = office ? saved?.source === "office" : false;
              const inherited = office != null && !own && !(e && "value" in e);
              const unit = unitFor(c.key);
              const typed = typedAmount(data.rows, c.key, unit, office, today);
              const shown =
                e && "value" in e
                  ? e.value
                  : e && "reset" in e
                    ? ""
                    : typed
                      ? typed.amount.toFixed(2)
                      : "";
              const hourly = perHourOf(shown, unit);
              const edits = pending.edits[c.key] ?? {};
              const name = edits.name ?? c.name;
              const willArchive = pending.archived.includes(c.key);
              /* 5 Nov (T9): vehicle finance, insurance and maintenance are
                 summed from Fleet (fleet_overhead_sync) — shown, never typed.
                 The database refuses a typed value for them too. */
              if (isFleetComponent(c.key)) {
                return (
                  <li
                    key={c.key}
                    className="space-y-2 rounded-lg border bg-muted/30 p-3 md:grid md:grid-cols-[minmax(0,1fr)_17rem_minmax(0,1fr)_5rem] md:items-start md:gap-3 md:space-y-0 md:rounded-none md:border-0 md:px-3 md:py-2"
                    data-component={c.key}
                    data-fleet-component
                  >
                    <div className="text-sm">
                      <div className="flex min-h-8 items-center font-medium">{c.name}</div>
                      <Badge variant="outline" className="mt-1 normal-case tracking-normal">
                        from Fleet
                      </Badge>
                    </div>
                    <div>
                      <div className="flex min-h-8 items-center gap-1">
                        <span className="text-sm tabular-nums">
                          {typed ? `$${typed.amount.toFixed(2)}` : "$0.00"}
                          <span className="text-muted-foreground">
                            {" "}
                            / {unit.name.toLowerCase()}
                          </span>
                        </span>
                        <HistoryButton
                          book="overhead"
                          itemKey={c.key}
                          label={c.name}
                          officeName={officeName}
                        />
                      </div>
                      <p className="mt-0.5 text-[11px] text-muted-foreground" data-per-hour>
                        = {usd(saved?.value ?? 0)} / hr
                        {unit.key !== "hour" ? ` (÷ ${unit.hours} hrs)` : ""}
                        {office ? " · company-wide" : ""}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground md:pt-1.5">
                      {c.note ?? "From Fleet."}
                      {canOpenFleet && (
                        <>
                          {" "}
                          Change it on each vehicle in{" "}
                          <Link
                            to="/fleet"
                            className="text-link underline-offset-2 hover:underline"
                          >
                            Fleet
                          </Link>
                          .
                        </>
                      )}
                    </p>
                    <span />
                  </li>
                );
              }
              return (
                <li
                  key={c.key}
                  className={cn(
                    "space-y-2 rounded-lg border p-3 md:grid md:grid-cols-[minmax(0,1fr)_17rem_minmax(0,1fr)_5rem] md:items-start md:gap-3 md:space-y-0 md:rounded-none md:border-0 md:px-3 md:py-2",
                    (e || pending.units[c.key] || pending.edits[c.key]) &&
                      "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]",
                    willArchive && "opacity-60",
                  )}
                  data-component={c.key}
                >
                  <div className="text-sm">
                    <Input
                      value={name}
                      onChange={(ev) => editComponent(c.key, { name: ev.target.value })}
                      aria-label={`Name of ${c.name}`}
                      aria-invalid={problems.has(`name|${c.key}`) || undefined}
                      className={cn(
                        "h-11 font-medium md:h-8",
                        problems.has(`name|${c.key}`) && "border-destructive",
                      )}
                    />
                    {problems.has(`name|${c.key}`) && (
                      <p className="mt-1 text-xs text-destructive">
                        {problems.get(`name|${c.key}`)}
                      </p>
                    )}
                    {c.system && (
                      <Badge variant="outline" className="mt-1 normal-case tracking-normal">
                        standard
                      </Badge>
                    )}
                    {willArchive && (
                      <span className="ml-1.5 text-xs text-warning">archives on save</span>
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-1">
                      <span className="text-sm text-muted-foreground">$</span>
                      <Input
                        value={shown}
                        onChange={(ev) => edit(c.key, ev.target.value)}
                        inputMode="decimal"
                        placeholder={e && "reset" in e ? "default" : "Set"}
                        aria-label={`${c.name} per ${unit.name.toLowerCase()} at ${officeName(office)}`}
                        aria-invalid={problems.has(id) || undefined}
                        className={cn(
                          "h-11 w-24 tabular-nums md:h-8",
                          inherited && "text-muted-foreground",
                          own && "border-dashed border-link",
                          problems.has(id) && "border-destructive",
                        )}
                      />
                      <UnitSelect
                        units={units}
                        value={unit.key}
                        disabled={!data.unitsAvailable}
                        label={`Unit for ${c.name}`}
                        onChange={(u) =>
                          setPending((p) => {
                            const units = { ...p.units };
                            if (u === (c.unit_key ?? "hour")) delete units[c.key];
                            else units[c.key] = u;
                            return { ...p, units };
                          })
                        }
                      />
                      {office && own && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-11 w-11 md:h-8 md:w-8"
                          onClick={() => reset(c.key)}
                          aria-label={`Reset ${c.name} at ${officeName(office)} to the company default`}
                          title="Reset to the company default"
                        >
                          <RotateCcw aria-hidden />
                        </Button>
                      )}
                      <HistoryButton
                        book="overhead"
                        itemKey={c.key}
                        label={c.name}
                        officeName={officeName}
                      />
                    </div>
                    {(unit.key !== "hour" || (inherited && saved)) && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground" data-per-hour>
                        {unit.key !== "hour" && hourly != null && !Number.isNaN(hourly)
                          ? `= ${usd(hourly)} / hr (÷ ${unit.hours} hrs)`
                          : ""}
                        {unit.key !== "hour" && typed && !typed.exact && !(e && "value" in e)
                          ? " · was entered per hour"
                          : ""}
                        {inherited && saved
                          ? `${unit.key !== "hour" ? " · " : ""}from default`
                          : ""}
                      </p>
                    )}
                    {problems.has(id) && (
                      <p className="mt-1 text-xs text-destructive">{problems.get(id)}</p>
                    )}
                  </div>
                  <Input
                    value={edits.note ?? c.note ?? ""}
                    onChange={(ev) => editComponent(c.key, { note: ev.target.value })}
                    placeholder="Note"
                    aria-label={`Note for ${c.name}`}
                    className="h-11 text-xs text-muted-foreground md:h-8"
                  />
                  <div className="md:pt-1">
                    {!c.system && !willArchive && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-11 md:h-8"
                        onClick={() =>
                          setPending((p) => ({ ...p, archived: [...p.archived, c.key] }))
                        }
                      >
                        <Archive aria-hidden /> Archive
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
            {pending.added.map((a, i) => (
              <li
                key={`new-${i}`}
                className="flex flex-wrap items-center gap-2 bg-muted/50 px-3 py-2 text-sm shadow-[inset_3px_0_0_var(--gold)]"
              >
                <span className="font-medium">{a.name}</span>
                <span className="tabular-nums">
                  {a.value
                    ? `$${a.value} / ${unitById(a.unit).name.toLowerCase()}`
                    : "no value yet"}
                </span>
                <span className="text-xs text-muted-foreground">{a.note}</span>
                <span className="text-xs text-muted-foreground">new — added on save</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-11 md:h-8"
                  onClick={() =>
                    setPending((p) => ({ ...p, added: p.added.filter((_, j) => j !== i) }))
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-end gap-2 border-t px-3 pt-3">
            <label className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
              Add component
              <Input
                value={adding.name}
                onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))}
                placeholder="e.g. Vehicle allowance"
                className="mt-1 h-11 md:h-8"
              />
            </label>
            <label className="w-28 text-xs text-muted-foreground">
              Amount $
              <Input
                value={adding.value}
                onChange={(e) => setAdding((a) => ({ ...a, value: e.target.value }))}
                inputMode="decimal"
                placeholder="0.00"
                className="mt-1 h-11 tabular-nums md:h-8"
              />
            </label>
            {data.unitsAvailable && (
              <div className="text-xs text-muted-foreground">
                Per
                <UnitSelect
                  units={units}
                  value={adding.unit}
                  label="Unit for the new component"
                  className="mt-1"
                  onChange={(unit) => setAdding((a) => ({ ...a, unit }))}
                />
              </div>
            )}
            <label className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
              Note
              <Input
                value={adding.note}
                onChange={(e) => setAdding((a) => ({ ...a, note: e.target.value }))}
                placeholder="What it covers"
                className="mt-1 h-11 md:h-8"
              />
            </label>
            <Button
              variant="outline"
              className="h-11 md:h-8"
              disabled={
                !adding.name.trim() ||
                (adding.value.trim() !== "" && Number.isNaN(parseMoney(adding.value) ?? 0)) ||
                live.some((c) => c.name.toLowerCase() === adding.name.trim().toLowerCase())
              }
              onClick={() => {
                setPending((p) => ({
                  ...p,
                  added: [
                    ...p.added,
                    {
                      name: adding.name.trim(),
                      value: adding.value.trim(),
                      note: adding.note.trim(),
                      unit: adding.unit,
                    },
                  ],
                }));
                setAdding({ name: "", value: "", note: "", unit: "hour" });
              }}
            >
              <Plus aria-hidden /> Add component
            </Button>
          </div>
          {archivedComps.length > 0 && (
            <p className="px-3 text-xs text-muted-foreground">
              Archived: {archivedComps.map((c) => c.name).join(", ")} — kept in the history below.
            </p>
          )}
        </CardContent>
      </Card>

      <Card data-temp-wage>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Temp crew wage — field work ticket temps</CardTitle>
          <p className="text-xs text-muted-foreground">
            What an hour of a hired temp costs. Not part of the engine (temps are an agency invoice,
            not payroll); the field work ticket&rsquo;s Temp crew box is costed at it.
          </p>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {officeName(office)}:{" "}
            {tempNow ? `${usd(tempNow.rate)}/hr${tempNow.own ? "" : " (company-wide)"}` : "not set"}
          </span>
          <span className="text-sm text-muted-foreground">$</span>
          <Input
            value={pending.temp && "value" in pending.temp ? pending.temp.value : ""}
            onChange={(e) =>
              setPending((p) => ({
                ...p,
                temp: e.target.value.trim() ? { value: e.target.value } : null,
              }))
            }
            inputMode="decimal"
            placeholder="New rate"
            aria-label={`Temp crew wage at ${officeName(office)}`}
            className="h-11 w-28 tabular-nums md:h-8"
          />
          {office && tempNow?.own && (
            <Button
              variant="ghost"
              size="sm"
              className="h-11 md:h-8"
              onClick={() => setPending((p) => ({ ...p, temp: { reset: true } }))}
            >
              <RotateCcw aria-hidden /> Use company-wide
            </Button>
          )}
          {problems.has("temp") && (
            <p className="w-full text-xs text-destructive">{problems.get("temp")}</p>
          )}
        </CardContent>
      </Card>

      <YearOverYear data={data} office={office} officeLabel={officeName(office)} />

      <OtherLaborRates rows={data.labour} officeName={officeName} />

      {unitsOpen && (
        <UnitsDialog units={units} onClose={() => setUnitsOpen(false)} onSaved={refresh} />
      )}

      <SaveBar
        pending={count}
        problems={problems.size}
        note={note}
        onNote={setNote}
        saving={saving}
        onSave={() => void save()}
        onDiscard={discard}
        noteRequired
        hint="Every engine change needs a note. Field labor costs follow from the same date; existing jobs keep theirs."
        extra={
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Takes effect
            <Input
              type="date"
              min={today}
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value || today)}
              className="h-11 w-40 md:h-8"
              aria-label="Takes effect on"
            />
          </label>
        }
      />
    </div>
  );
}

/** The temp crew rate in force at an office: its own, else company-wide. */
function currentTemp(rows: readonly LegacyLaborRate[], office: string | null, today: string) {
  const live = rows.filter(
    (r) =>
      r.crew_class === "temp" &&
      !r.user_id &&
      r.effective_from <= today &&
      (!r.effective_to || r.effective_to >= today),
  );
  const own = office ? live.find((r) => r.location_id === office) : undefined;
  const wide = live.find((r) => r.location_id == null);
  const r = own ?? wide;
  return r ? { rate: r.hourly_rate, own: !!own } : null;
}

/** Re-run the auto-fill from today (needs a note, like any engine change). */
function ApplyButton({ onDone }: { onDone: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="h-11 md:h-8">
          <RefreshCw aria-hidden /> Apply to labor costs
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-3" align="end">
        <p className="text-sm">
          Write today&rsquo;s engine figure onto every field labor title&rsquo;s cost, from today.
          Publishing does this by itself; use this once to bring carried-over costs in line.
        </p>
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? Required"
          aria-label="Note for applying the engine"
          className="h-11 md:h-8"
        />
        <Button
          variant="cta"
          className="w-full"
          disabled={!note.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await saveOverhead([{ op: "apply" }], note);
              toast.success("Field labor costs now follow the engine");
              setOpen(false);
              setNote("");
              await onDone();
            } catch (err) {
              toastDbError(err, { action: "Applying the overhead engine" });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Applying…" : "Apply from today"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function YearOverYear({
  data,
  office,
  officeLabel,
}: {
  data: OverheadData;
  office: string | null;
  officeLabel: string;
}) {
  const points = useMemo(() => engineTimeline(data.rows, data.components, office), [data, office]);
  const today = localToday();
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
  const [a, setA] = useState(yearAgo);
  const [b, setB] = useState(today);
  const cmp = compareEngine(data.rows, data.components, office, a, b);
  return (
    <Card data-engine-timeline>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Cost per hour over time · {officeLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Sparkline points={points} />
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Compare
          <Input
            type="date"
            value={a}
            onChange={(e) => setA(e.target.value || yearAgo)}
            className="h-11 w-40 md:h-8"
            aria-label="First date"
          />
          with
          <Input
            type="date"
            value={b}
            onChange={(e) => setB(e.target.value || today)}
            className="h-11 w-40 md:h-8"
            aria-label="Second date"
          />
        </div>
        <p className="rounded-md bg-muted/50 px-3 py-2 text-sm" data-engine-why>
          {explainCompare(cmp)}
        </p>
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-medium">From</th>
                <th className="py-1 pr-3 text-right font-medium">Per hour</th>
                <th className="py-1 font-medium">What changed</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...points].reverse().map((p) => (
                <tr key={p.date}>
                  <td className="py-1.5 pr-3 whitespace-nowrap">{formatDateUS(p.date)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{usd(p.total)}</td>
                  <td className="py-1.5 text-muted-foreground">
                    {p.changes.length === 0
                      ? "Starting point"
                      : p.changes
                          .map(
                            (c) =>
                              `${c.name} ${c.from == null ? "set" : usd(c.from)} → ${c.to == null ? "removed" : usd(c.to)}`,
                          )
                          .join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Sparkline({ points }: { points: ReturnType<typeof engineTimeline> }) {
  if (points.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        One value so far — the line starts at the next change.
      </p>
    );
  }
  const W = 320;
  const H = 56;
  const t = (d: string) => new Date(`${d}T00:00:00Z`).getTime();
  const end = Math.max(t(points[points.length - 1]!.date), Date.now());
  const start = t(points[0]!.date);
  const min = Math.min(...points.map((p) => p.total));
  const max = Math.max(...points.map((p) => p.total));
  const x = (d: string) => ((t(d) - start) / Math.max(1, end - start)) * (W - 8) + 4;
  const y = (v: number) => (max === min ? H / 2 : H - 6 - ((v - min) / (max - min)) * (H - 12));
  let path = "";
  points.forEach((p, i) => {
    path += i === 0 ? `M${x(p.date)},${y(p.total)}` : ` H${x(p.date)} V${y(p.total)}`;
  });
  path += ` H${W - 4}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-14 w-full max-w-md"
      role="img"
      aria-label={`Cost per hour from ${usd(points[0]!.total)} to ${usd(points[points.length - 1]!.total)}`}
    >
      <path d={path} fill="none" stroke="var(--primary)" strokeWidth="2" />
      {points.slice(1).map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.total)} r="3" fill="var(--gold)">
          <title>
            {formatDateUS(p.date)}: {usd(p.total)} — {p.changes.map((c) => c.name).join(", ")}
          </title>
        </circle>
      ))}
    </svg>
  );
}

const CLASS_LABEL: Record<string, string> = {
  gsr: "Field crew (Gold Star)",
  temp: "Field crew (temp)",
};

/** Every labor cost rate on file, read only — nothing is dropped (series rule 2). */
function OtherLaborRates({
  rows,
  officeName,
}: {
  rows: readonly LegacyLaborRate[];
  officeName: (id: string | null) => string;
}) {
  const others = rows.filter(
    (r) => !(r.crew_class && !r.user_id) && !(r.role === "crew" && !r.user_id),
  );
  if (!others.length) return null;
  return (
    <details className="rounded-lg border bg-card">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
        Other labor rates on file ({others.length}) — read only
      </summary>
      <p className="px-3 text-xs text-muted-foreground">
        Rates published before the engine for other roles or people. Kept as they were; the
        engine&rsquo;s Wage is the field crew&rsquo;s.
      </p>
      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto px-3 pb-3">
        <table className="mt-2 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">For</th>
              <th className="py-1 pr-3 font-medium">Office</th>
              <th className="py-1 pr-3 text-right font-medium">$ / hour</th>
              <th className="py-1 font-medium">In force</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {others.map((r) => (
              <tr key={r.id}>
                <td className="py-1.5 pr-3">
                  {r.user_id
                    ? "A named person"
                    : r.crew_class
                      ? CLASS_LABEL[r.crew_class]
                      : r.role
                        ? r.role.replace(/_/g, " ")
                        : "Company-wide"}
                </td>
                <td className="py-1.5 pr-3">{officeName(r.location_id)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{usd(r.hourly_rate)}</td>
                <td className="py-1.5 text-muted-foreground">
                  {formatDateUS(r.effective_from)} –{" "}
                  {r.effective_to ? formatDateUS(r.effective_to) : "now"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function UnitSelect({
  units,
  value,
  onChange,
  label,
  disabled,
  className,
}: {
  units: readonly OverheadUnit[];
  value: string;
  onChange: (unit: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className={cn("h-11 w-28 md:h-8", className)} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {units.map((u) => (
          <SelectItem key={u.key} value={u.key}>
            / {u.name.toLowerCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * The units a component can be entered in, and the field hours each covers.
 * Saved on its own (with a note), not with the engine's Save: a unit is a
 * setting, not a dated value. Hour stays one hour.
 */
function UnitsDialog({
  units,
  onClose,
  onSaved,
}: {
  units: readonly OverheadUnit[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [edits, setEdits] = useState<Record<string, { name?: string; hours?: string }>>({});
  const [adding, setAdding] = useState({ name: "", hours: "" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const hoursOk = (h: string) => /^\d+(\.\d{1,2})?$/.test(h.trim()) && Number(h) > 0;

  const changes: Record<string, unknown>[] = [];
  let invalid = false;
  for (const [key, e] of Object.entries(edits)) {
    const u = units.find((x) => x.key === key);
    if (!u) continue;
    const name = e.name?.trim();
    const hours = e.hours?.trim();
    if ((name !== undefined && !name) || (hours !== undefined && !hoursOk(hours))) invalid = true;
    const change: Record<string, unknown> = { op: "unit_edit", unit: key };
    if (name && name !== u.name) change.name = name;
    if (hours && hoursOk(hours) && Number(hours) !== u.hours) change.hours = Number(hours);
    if (Object.keys(change).length > 2) changes.push(change);
  }
  const addReady = adding.name.trim() !== "" && hoursOk(adding.hours);
  const taken = units.some((u) => u.name.toLowerCase() === adding.name.trim().toLowerCase());
  if (adding.name.trim() || adding.hours.trim()) {
    if (!addReady || taken) invalid = true;
    else changes.push({ op: "unit_add", name: adding.name.trim(), hours: Number(adding.hours) });
  }

  async function save() {
    if (invalid || !changes.length || !note.trim()) return;
    setBusy(true);
    try {
      await saveOverhead(changes, note);
      toast.success("Units saved", {
        description: "A changed unit counts from the next value typed in it.",
      });
      await onSaved();
      onClose();
    } catch (err) {
      toastDbError(err, { action: "Saving the units" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" data-units-dialog>
        <DialogHeader>
          <DialogTitle>Units</DialogTitle>
          <DialogDescription>
            What a component can be entered per, and how many field-labor hours that covers. The
            engine counts amount ÷ hours. Values already published keep their $/hour.
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y rounded-md border">
          <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2 bg-muted px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span>Unit</span>
            <span>Field hours</span>
          </div>
          {units.map((u) => {
            const e = edits[u.key] ?? {};
            return (
              <div key={u.key} className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2 px-3 py-1.5">
                <Input
                  value={e.name ?? u.name}
                  onChange={(ev) =>
                    setEdits((x) => ({ ...x, [u.key]: { ...x[u.key], name: ev.target.value } }))
                  }
                  disabled={u.system}
                  aria-label={`Name of ${u.name}`}
                  className="h-11 md:h-8"
                />
                <Input
                  value={e.hours ?? String(u.hours)}
                  onChange={(ev) =>
                    setEdits((x) => ({ ...x, [u.key]: { ...x[u.key], hours: ev.target.value } }))
                  }
                  disabled={u.system}
                  inputMode="decimal"
                  aria-label={`Field hours in a ${u.name.toLowerCase()}`}
                  aria-invalid={(e.hours !== undefined && !hoursOk(e.hours)) || undefined}
                  className={cn(
                    "h-11 tabular-nums md:h-8",
                    e.hours !== undefined && !hoursOk(e.hours) && "border-destructive",
                  )}
                />
              </div>
            );
          })}
          <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2 px-3 py-1.5">
            <Input
              value={adding.name}
              onChange={(e) => setAdding((a) => ({ ...a, name: e.target.value }))}
              placeholder="Add a unit, e.g. Quarter"
              aria-label="New unit name"
              aria-invalid={taken || undefined}
              className="h-11 md:h-8"
            />
            <Input
              value={adding.hours}
              onChange={(e) => setAdding((a) => ({ ...a, hours: e.target.value }))}
              placeholder="Hours"
              inputMode="decimal"
              aria-label="Field hours in the new unit"
              className="h-11 tabular-nums md:h-8"
            />
          </div>
        </div>
        {taken && <p className="text-xs text-destructive">There is already a unit called that.</p>}
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? Required for the change log"
          aria-label="Note for the change log"
          className="h-11 md:h-9"
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={busy || invalid || !changes.length || !note.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save units"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
